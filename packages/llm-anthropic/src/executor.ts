// ── Anthropic phase executor ────────────────────────────────────────────────
//
// The default LLM provider that ships with every Coro install. Wraps the
// Claude Agent SDK's `query()` function and exposes it through the
// {@link PhaseExecutorRuntime} contract so the runner can call providers
// uniformly. The runner core never imports `@anthropic-ai/claude-agent-sdk`
// directly; it always goes through this executor (resolved via
// `PluginRegistry.resolveExecutor`).
//
// Responsibilities:
//   - Capability declaration, model catalogue, supports() predicate.
//   - Lifecycle (init/healthcheck/dispose) — auth-shape validation; the
//     SDK lazy-validates the API key on first call.
//   - `executePhase()` runs a single phase: builds the SDK options
//     (auth, MCP servers, hooks, settingSources), drives the streaming
//     `query()` loop, translates raw SDK messages into provider-neutral
//     {@link PhaseExecutorEvent}s, and exposes a session controller for
//     mid-flight steering messages.
//   - Plugin config (auth, default model, …) is the Zod-validated
//     `plugins.installed.anthropic.config` blob; legacy `settings.claude.*`
//     is migrated by the runner bootstrap and is no longer read here.

import { z } from 'zod'
import { mkdirSync } from 'fs'
import type { Logger } from 'pino'
import {
  query,
  type McpServerConfig,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { ensureClaudeCodeCliExecutable, resolveClaudeCodeCliPath } from './cli-path'
import type {
  ChatRequest,
  ChatResult,
  ChatTool,
  ChatToolCallRecord,
  ConversationMessage,
  NormalizedTokenUsage,
  ExecutorCapabilities,
  ExecutorModelDescriptor,
  ExecutorSessionController,
  PhaseExecutionRequest,
  PhaseExecutorEvent,
  PhaseExecutorRuntime,
  PluginDeps,
  PluginHealth,
  PluginHttpRoutesContext,
  PluginManifest,
  PluginMcpServerConfig,
  PluginTestResult,
} from '@coro-ai/plugin-sdk'
import { RateLimitExceededError, classifyProviderError, tierDefaultAliases } from '@coro-ai/plugin-sdk'
import type { ClassifyOptions } from '@coro-ai/plugin-sdk'
import { buildAnthropicAuthEnv } from './auth'
import { registerAnthropicHttpRoutes } from './http-routes'
import { formatAnthropicAuthFailure, testAnthropicCredentials } from './test-connection'
import { isSessionExpired, loadClaudeLocalSession } from './credential-store'
import { buildPhaseHooks } from './hooks'
import { createPushableInput } from './pushable'
import { linkAbortController } from './abort-link'
import { ensureClaudeConfigSymlink } from './intelligence-symlink'
import { healMcpTransport, isCoroMcpHealthy, MCP_RETRY_NUDGE } from './mcp-heal'
import { reattachDynamicMcpServers } from './mcp-reattach'
import {
  isBunSourceFrameLine,
  isMcpHealExhaustedError,
  isMcpInputDeadText,
  isMcpTransportErrorText,
  isRecoverableSteeringAbort,
  isSteeringDiagnosticText,
  shouldClosePushableAfterResult,
} from './steering-errors'
import { chatViaAgentSdk, shouldChatViaAgentSdk, shouldRouteChatViaAgentSdk } from './chat-via-sdk'
import type { AnthropicExecutorSettings, ClaudeAuthConfig } from './types'
import type { ExecutorSandboxReport, SteeringInterruptMode } from '@coro-ai/plugin-sdk'
import { probeHostSandbox } from './sandbox-probe'

/** Mutable mirror of NormalizedTokenUsage — used as the executor's running cumulative tally. */
interface NormalizedTokensMutable {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  totalCostUsd?: number
}

/** Translate a generic ConversationMessage into the SDK's user-message shape. */
function toSdkUserMessage(msg: ConversationMessage): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: msg.content }],
    },
    parent_tool_use_id: null,
  }
}

// ── Static manifest data ─────────────────────────────────────────────────────

const ANTHROPIC_PLUGIN_ID = 'anthropic' as const

/**
 * Fallback wait when we recognise a Claude Code subprocess rate-limit
 * by its message text but didn't capture the companion
 * `rate_limit_event` (different SDK build, stream cut early, etc.).
 * The runner's RateLimitScheduler layers exponential backoff on top
 * via `nextBackoffMs(attempt, hintMs)`, so repeated misses ramp up
 * gracefully — we don't pretend to know the real deadline here.
 */
const FALLBACK_CLAUDE_CODE_RATE_LIMIT_MS = 5 * 60 * 1000

/** How long a successful live auth probe is reused before re-checking. */
const AUTH_PROBE_TTL_MS = 5 * 60 * 1000

/**
 * Match the plain-text error message that the Claude Code subprocess
 * surfaces when its session-level rate limit (5-hour / weekly budget)
 * is exhausted. Example:
 *
 *   "Claude Code returned an error result: You've hit your limit · resets 6:50pm (Asia/Famagusta)"
 *
 * This is Anthropic-SDK-specific shape detection — kept local to this
 * package rather than leaking into the provider-neutral classifier in
 * `@coro-ai/plugin-sdk`.
 */
function isClaudeCodeRateLimitMessage(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const message = (err as { message?: unknown }).message
  if (typeof message !== 'string') return false
  return /hit your limit|claude code returned an error result.*limit/i.test(message)
}

/**
 * Anthropic-specific extensions for the shared
 * {@link classifyProviderError} helper. Keeping vendor-specific
 * detection here (rather than in `@coro-ai/plugin-sdk`) is what lets
 * the shared classifier stay provider-neutral.
 */
const ANTHROPIC_CLASSIFY_OPTIONS: ClassifyOptions = {
  // The Anthropic Node SDK throws subclasses named `RateLimitError`
  // when the API returns 429 — but not all transports surface the
  // status code (notably the Claude Code subprocess re-wraps errors),
  // so we match the class name too.
  detectRateLimit: (err: unknown): boolean => {
    if (!err || typeof err !== 'object') return false
    const e = err as Record<string, unknown>
    if (typeof e.name === 'string' && e.name === 'RateLimitError') return true
    const ctor = (e as { constructor?: { name?: string } }).constructor
    return ctor?.name === 'RateLimitError'
  },
  // Anthropic surfaces transient capacity errors as HTTP 5xx with an
  // embedded `{ error: { type: 'overloaded_error' } }` body rather
  // than HTTP 529. We probe both `err.error` and `err.body.error`
  // because different SDK versions nest the body differently.
  detectOverloaded: (err: unknown): boolean => {
    if (!err || typeof err !== 'object') return false
    const e = err as Record<string, unknown>
    const error = e.error as Record<string, unknown> | undefined
    if (error && error.type === 'overloaded_error') return true
    const body = e.body as Record<string, unknown> | undefined
    const bodyError = body?.error as Record<string, unknown> | undefined
    if (bodyError && bodyError.type === 'overloaded_error') return true
    return false
  },
  // Anthropic's REST API emits `anthropic-ratelimit-reset-{tokens,requests}`
  // (ISO 8601 timestamp). We list tokens first because token quota is
  // what an agent typically exhausts mid-phase. `extractRetryHint`
  // takes the largest wait when multiple match, so order is only a
  // documentation hint.
  extraResetHeaders: [
    'anthropic-ratelimit-reset-tokens',
    'anthropic-ratelimit-reset-requests',
  ],
}

/**
 * Static catalogue of Anthropic models the executor recommends. Used by:
 *   - The dashboard's model picker (per-provider dropdown).
 *   - `resolveExecutor({ model })` model-→-provider inference.
 *   - The conformance harness to validate `supports()` consistency.
 *
 * Pricing is published purely as a **pre-run preview hint** for the
 * dashboard cost preview. Runtime accounting still trusts the
 * `total_cost_usd` field the Anthropic Agent SDK reports on every
 * result event — we do not derive cost from these tables. Numbers are
 * USD per million tokens, indexed to Anthropic's published price list
 * for the closest current-generation tier; out-of-date by a few
 * percent is fine for preview, never for invoicing.
 */
const ANTHROPIC_MODELS: ReadonlyArray<ExecutorModelDescriptor> = [
  // Current generation — dateless IDs are pinned snapshots, not evergreen
  // pointers. Source: platform.claude.com/docs models overview.
  {
    id: 'claude-fable-5',
    displayName: 'Claude Fable 5',
    contextTokens: 1_000_000,
    tier: 'planning',
    supportsThinking: true,
    pricing: { inputPerMTokens: 10, outputPerMTokens: 50, cacheReadPerMTokens: 1 },
  },
  {
    id: 'claude-opus-4-8',
    displayName: 'Claude Opus 4.8',
    contextTokens: 1_000_000,
    tier: 'planning',
    isDefault: true,
    supportsThinking: true,
    pricing: { inputPerMTokens: 5, outputPerMTokens: 25, cacheReadPerMTokens: 0.5 },
  },
  {
    id: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    contextTokens: 1_000_000,
    tier: 'coding',
    isDefault: true,
    supportsThinking: true,
    pricing: { inputPerMTokens: 3, outputPerMTokens: 15, cacheReadPerMTokens: 0.3 },
  },
  {
    id: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    contextTokens: 200_000,
    tier: 'mini',
    isDefault: true,
    supportsThinking: true,
    pricing: { inputPerMTokens: 0.8, outputPerMTokens: 4, cacheReadPerMTokens: 0.08 },
  },
  // Previous generation — kept available for cost/latency tuning and
  // for tenants that have pinned older IDs in their workflow front matter.
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    contextTokens: 1_000_000,
    tier: 'coding',
    supportsThinking: true,
    pricing: { inputPerMTokens: 3, outputPerMTokens: 15, cacheReadPerMTokens: 0.3 },
  },
  {
    id: 'claude-sonnet-4-5',
    displayName: 'Claude Sonnet 4.5',
    contextTokens: 200_000,
    tier: 'coding',
    supportsThinking: true,
    pricing: { inputPerMTokens: 3, outputPerMTokens: 15, cacheReadPerMTokens: 0.3 },
  },
  {
    id: 'claude-opus-4-7',
    displayName: 'Claude Opus 4.7',
    contextTokens: 1_000_000,
    tier: 'planning',
    supportsThinking: true,
    pricing: { inputPerMTokens: 15, outputPerMTokens: 75, cacheReadPerMTokens: 1.5 },
  },
]

const ANTHROPIC_CAPABILITIES: ExecutorCapabilities = {
  supportsNativeSubagents: true,
  supportsClaudeMdNativeWalkUp: true,
  supportsNativeFileTools: true,
  supportsSessionResume: true,
  supportsConversationReplay: false,
  supportsThinking: true,
  supportsImageInput: true,
  maxContextTokens: 1_000_000,
}

// Plugin config schema. The runner persists this verbatim under
// `plugins.installed.anthropic.config` and hands it to {@link
// AnthropicExecutor.init}. Mirrors {@link ClaudeAuthConfig} so the
// dashboard can edit it directly without translation. All fields are
// optional so a freshly-bootstrapped install (no creds yet) still
// passes registration — healthcheck surfaces the missing-cred case.
const anthropicConfigSchema = z.object({
  method: z.enum(['apiKey', 'oauth', 'claudeLogin']).optional(),
  apiKey: z.string().optional(),
  oauthToken: z.string().optional(),
  account: z.object({
    email: z.string().optional(),
    organization: z.string().optional(),
    subscriptionType: z.string().optional(),
    tokenSource: z.string().optional(),
    apiKeySource: z.string().optional(),
    apiProvider: z.enum(['firstParty', 'bedrock', 'vertex', 'foundry', 'anthropicAws', 'mantle']).optional(),
  }).partial().optional(),
}).passthrough()

export const ANTHROPIC_MANIFEST: PluginManifest = {
  id: ANTHROPIC_PLUGIN_ID,
  kind: 'executor',
  version: '1.0.0',
  displayName: 'Anthropic (Claude Agent SDK)',
  // Pinned to the runner's host plugin-API version. Bumped via the
  // standard semver process when the executor contract evolves.
  hostCompatibility: '^1.0.0',
  configSchema: anthropicConfigSchema,
  capabilities: {
    /** True when the executor's tool loop and MCP plumbing are complete. */
    supportsClaudeAgentSdk: true,
  },
  ui: {
    subtitle: 'Best results today. One-click sign-in with Claude login.',
    recommendedForOnboarding: true,
  },
  auth: {
    methods: [
      {
        kind: 'oauth',
        id: 'claude-login',
        label: 'Connect Claude',
        recommended: true,
        startPath: '/config/anthropic/claude-login/start',
        statusPath: '/config/anthropic/claude-login/status',
        configOnSelect: { method: 'claudeLogin' },
        successAccountPath: 'account.email',
      },
      {
        kind: 'form',
        id: 'api-key',
        label: 'API key',
        configOnSelect: { method: 'apiKey' },
        fields: [
          {
            key: 'apiKey',
            label: 'API key',
            kind: 'secret',
            placeholder: 'sk-ant-…',
            hint: 'From console.anthropic.com.',
            required: true,
          },
        ],
      },
    ],
  },
}

// ── Runtime ──────────────────────────────────────────────────────────────────

export interface AnthropicExecutorOptions {
  /**
   * Reference to the runner's resolved Settings. Used to read SCM env
   * (BitBucket / GitHub) for the agent's git push environment. Auth
   * is delivered separately via {@link auth} or {@link init}.
   */
  settings: AnthropicExecutorSettings
  /**
   * Initial Anthropic auth config. The runner constructs this from
   * `plugins.installed.anthropic.config` at registration time. May be
   * overridden later by {@link init}; defaults to a stub so tests that
   * don't exercise auth can omit it entirely.
   */
  auth?: ClaudeAuthConfig
  /** Pino logger; the runner injects its own scoped child logger. */
  logger: Logger
}

export class AnthropicExecutor implements PhaseExecutorRuntime {
  readonly manifest = ANTHROPIC_MANIFEST
  readonly kind = 'executor' as const
  readonly capabilities = ANTHROPIC_CAPABILITIES

  private readonly settings: AnthropicExecutorSettings
  private auth: ClaudeAuthConfig
  private readonly logger: Logger
  /** Timestamp of the last *successful* live auth probe; see {@link AUTH_PROBE_TTL_MS}. */
  private authProbeOkAt: number | null = null
  /** `undefined` = not probed yet; `null` = probed, no host sandbox. */
  private sandboxProbe: ExecutorSandboxReport | null | undefined = undefined

  constructor(opts: AnthropicExecutorOptions) {
    this.settings = opts.settings
    this.auth = opts.auth ?? { method: 'apiKey', apiKey: '' }
    this.logger = opts.logger.child({ component: 'AnthropicExecutor' })
  }

  // ── Plugin lifecycle ───────────────────────────────────────────────────────

  /**
   * Adopts the auth fields from the persisted plugin config. The
   * Claude Agent SDK validates auth lazily on first `query()` call, so
   * we surface auth issues there rather than reproducing the
   * validation ladder in two places. `_deps` accepted for contract
   * conformance.
   */
  async init(config: unknown, _deps: PluginDeps): Promise<void> {
    const parsed = anthropicConfigSchema.safeParse(config ?? {})
    if (!parsed.success) {
      this.logger.warn({ err: parsed.error.message }, 'Anthropic plugin config failed schema validation — keeping current auth')
      return
    }
    const cfg = parsed.data
    if (cfg.method) {
      this.auth = {
        method: cfg.method,
        ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
        ...(cfg.oauthToken ? { oauthToken: cfg.oauthToken } : {}),
        ...(cfg.account ? { account: cfg.account } : {}),
      }
      this.authProbeOkAt = null
    }
  }

  /**
   * Reports `ok` whenever some form of Anthropic auth is configured.
   * Does NOT round-trip to the Anthropic API — that would burn tokens
   * on every dashboard refresh. The dashboard's "Test connection" button
   * is the right place for an active probe.
   */
  async healthcheck(): Promise<PluginHealth> {
    const auth = this.auth
    if (auth.method === 'apiKey' && !auth.apiKey) {
      return { ok: false, reason: 'Anthropic auth method is "apiKey" but no apiKey is configured.' }
    }
    if (auth.method === 'oauth' && !auth.oauthToken) {
      return { ok: false, reason: 'Anthropic auth method is "oauth" but no oauthToken is configured.' }
    }
    if ((auth.method ?? 'claudeLogin') === 'claudeLogin') {
      try {
        const session = await loadClaudeLocalSession(this.logger)
        if (!session.accessToken) {
          return {
            ok: false,
            reason: 'Claude is not signed in on this machine.',
          }
        }
        if (isSessionExpired(session.expiresAt)) {
          return {
            ok: false,
            reason: 'Your Claude session has expired and could not be renewed. Click Reconnect in Settings.',
          }
        }
      } catch (err) {
        return { ok: false, reason: (err as Error).message }
      }
    }
    return { ok: true }
  }

  /**
   * Active credential probe. Distinct from {@link healthcheck} — this
   * one actually rings the Anthropic API to verify the credential is
   * accepted. Called from the dashboard's Test connection button via
   * the runner's `POST /test/llm` dispatcher.
   *
   * The `config` argument is the merged draft + on-disk config the
   * user is about to save; redacted secrets ('…') have already been
   * filled in upstream by the runner. We coerce it through the same
   * Zod schema {@link init} uses so a malformed payload surfaces as a
   * clear failure rather than a thrown exception.
   */
  async testConnection(config: unknown): Promise<PluginTestResult> {
    const parsed = anthropicConfigSchema.safeParse(config ?? {})
    if (!parsed.success) {
      return {
        ok: false,
        message: `Invalid Anthropic plugin config: ${parsed.error.message}`,
      }
    }
    const cfg = parsed.data
    const auth: ClaudeAuthConfig = {
      method: cfg.method ?? this.auth.method ?? 'claudeLogin',
      ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
      ...(cfg.oauthToken ? { oauthToken: cfg.oauthToken } : {}),
      ...(cfg.account ? { account: cfg.account } : {}),
    }
    return testAnthropicCredentials(auth)
  }

  async dispose(): Promise<void> {
    // The Claude Agent SDK owns its own subprocess lifecycle and tears
    // down on stream close. Nothing executor-owned to release here.
  }

  /**
   * Conversational chat used by Coro plan mode (`POST /intake/stream`).
   *
   * Routing:
   *   - `claudeLogin` / `oauth` → {@link chatViaAgentSdk} so subscription
   *     auth follows the same Claude Code subprocess path as job phases.
   *     Direct `/v1/messages` REST with an OAuth bearer token hits a
   *     different Anthropic gate and can spuriously 429 on Opus even when
   *     the account is not API rate-limited.
   *   - `apiKey` → direct `/v1/messages` REST (no subprocess startup).
   */
  async chat(req: ChatRequest): Promise<ChatResult> {
    const authMethod = this.auth.method ?? 'claudeLogin'
    if (shouldRouteChatViaAgentSdk(this.auth, req)) {
      await this.assertAuthReadyForSdk()
    }
    this.logger.debug(
      {
        model: req.model,
        messageCount: req.messages.length,
        toolCount: req.tools?.length ?? 0,
        signalAbortedAtEntry: req.signal.aborted,
        authMethod,
        viaAgentSdk: shouldChatViaAgentSdk(this.auth),
      },
      'anthropic.chat: invoked',
    )
    if (shouldRouteChatViaAgentSdk(this.auth, req)) {
      return chatViaAgentSdk(this, req)
    }

    const headers = await this.buildAnthropicRestHeaders()
    const hasTools = (req.tools?.length ?? 0) > 0 && typeof req.runTool === 'function'
    if (!hasTools) {
      return this.chatSingleShot(req, headers)
    }
    return this.chatWithTools(req, headers, req.tools!)
  }

  private async chatSingleShot(req: ChatRequest, headers: Record<string, string>): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxOutputTokens ?? 1024,
      messages: req.messages.map(m => ({ role: m.role, content: m.content })),
    }
    if (req.systemPrompt) body.system = req.systemPrompt

    const data = await this.postAnthropicMessages(headers, body, req)
    const output = extractAnthropicText(data.content ?? [])

    return {
      output,
      usage: normalizeAnthropicUsage(data.usage),
      toolCalls: [],
    }
  }

  private async chatWithTools(
    req: ChatRequest,
    headers: Record<string, string>,
    tools: ReadonlyArray<ChatTool>,
  ): Promise<ChatResult> {
    const maxRounds = req.maxToolRounds ?? 5
    const runTool = req.runTool!
    const toolCalls: ChatToolCallRecord[] = []
    let usage = emptyNormalizedUsage()

    type AnthropicMessage = { role: 'user' | 'assistant'; content: unknown }
    const messages: AnthropicMessage[] = req.messages.map(m => ({
      role: m.role,
      content: m.content,
    }))

    const anthropicTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }))

    let output = ''
    for (let round = 0; round < maxRounds; round++) {
      if (req.signal.aborted) break

      const body: Record<string, unknown> = {
        model: req.model,
        max_tokens: req.maxOutputTokens ?? 2048,
        messages,
        tools: anthropicTools,
      }
      if (req.systemPrompt) body.system = req.systemPrompt

      const data = await this.postAnthropicMessages(headers, body, req)
      usage = addUsage(usage, normalizeAnthropicUsage(data.usage))

      const content = data.content ?? []
      const stopReason = data.stop_reason ?? 'end_turn'
      const textParts = extractAnthropicText(content)
      if (textParts) output = textParts

      const toolUses = content.filter(
        (block): block is { type: 'tool_use'; id: string; name: string; input: unknown } =>
          block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string',
      )

      if (toolUses.length === 0 || stopReason !== 'tool_use') {
        break
      }

      messages.push({ role: 'assistant', content })

      const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = []
      for (const toolUse of toolUses) {
        req.onToolStart?.({ name: toolUse.name, input: toolUse.input })
        const startedAt = Date.now()
        let record: ChatToolCallRecord
        try {
          const result = await runTool(toolUse.name, toolUse.input)
          record = {
            name: toolUse.name,
            input: toolUse.input,
            output: result,
            durationMs: Date.now() - startedAt,
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: stringifyToolResult(result),
          })
        } catch (err) {
          const message = (err as Error).message
          record = {
            name: toolUse.name,
            input: toolUse.input,
            output: { error: message },
            durationMs: Date.now() - startedAt,
            error: message,
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({ error: message }),
            is_error: true,
          } as { type: 'tool_result'; tool_use_id: string; content: string })
        }
        toolCalls.push(record)
        req.onToolEnd?.(record)
      }

      messages.push({ role: 'user', content: toolResults })
    }

    return { output: output.trim(), usage, toolCalls }
  }

  private async postAnthropicMessages(
    headers: Record<string, string>,
    body: Record<string, unknown>,
    req: ChatRequest,
  ): Promise<{
    content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>
    stop_reason?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }> {
    let response: Response
    try {
      this.logger.debug({ model: req.model, signalAborted: req.signal.aborted }, 'anthropic.chat: posting to /v1/messages')
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      })
    } catch (err) {
      this.logger.warn(
        {
          err,
          errName: (err as { name?: string }).name,
          errMessage: (err as { message?: string }).message,
          signalAborted: req.signal.aborted,
        },
        'anthropic.chat: fetch threw',
      )
      if ((err as Error).name === 'AbortError') throw err
      throw new Error(`Anthropic chat request failed: ${(err as Error).message}`)
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '')
      const info = classifyProviderError(
        { status: response.status, message: errBody },
        ANTHROPIC_CLASSIFY_OPTIONS,
      )
      if (info) {
        throw new RateLimitExceededError(ANTHROPIC_PLUGIN_ID, info)
      }
      throw new Error(`Anthropic ${response.status}: ${errBody.slice(0, 400)}`)
    }

    return (await response.json()) as {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>
      stop_reason?: string
      usage?: {
        input_tokens?: number
        output_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
      }
    }
  }

  /**
   * Build the auth + version headers used by direct REST calls to
   * Anthropic. Mirrors {@link testAnthropicCredentials} so the
   * "Test connection" path and the live {@link chat} path agree on
   * which credential to send.
   */
  private async buildAnthropicRestHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    const method = this.auth.method ?? 'claudeLogin'
    if (method === 'apiKey') {
      const apiKey = (this.auth.apiKey ?? '').trim()
      if (!apiKey) throw new Error('Anthropic auth method is "apiKey" but no apiKey is configured.')
      headers['x-api-key'] = apiKey
      return headers
    }
    if (method === 'oauth') {
      const token = (this.auth.oauthToken ?? '').trim()
      if (!token) throw new Error('Anthropic auth method is "oauth" but no oauthToken is configured.')
      headers['Authorization'] = `Bearer ${token}`
      headers['anthropic-beta'] = 'oauth-2025-04-20'
      return headers
    }
    const session = await loadClaudeLocalSession(this.logger)
    if (!session.accessToken) {
      throw new Error('Claude session is not signed in on this machine. Connect Claude in Settings or switch to API key auth.')
    }
    if (isSessionExpired(session.expiresAt)) {
      throw new Error('Your Claude session has expired and could not be renewed. Reconnect Claude in Settings.')
    }
    headers['Authorization'] = `Bearer ${session.accessToken}`
    headers['anthropic-beta'] = 'oauth-2025-04-20'
    return headers
  }

  /**
   * Verify Anthropic credentials before spawning Claude Code. Surfaces
   * the same messages as Settings → Test connection instead of an opaque
   * SDK 401 mid-stream.
   */
  private async assertAuthReadyForSdk(): Promise<void> {
    const now = Date.now()
    if (this.authProbeOkAt !== null && now - this.authProbeOkAt < AUTH_PROBE_TTL_MS) return

    const result = await testAnthropicCredentials(this.auth)
    // Only successes are cached. A failed probe may have been transient (a
    // rotated token, a blip reaching Anthropic) and the probe itself renews
    // an aged-out session, so caching the failure would keep every retry
    // blocked for the whole TTL instead of letting the next one recover.
    if (!result.ok) {
      this.authProbeOkAt = null
      throw new Error(formatAnthropicAuthFailure(result))
    }
    this.authProbeOkAt = now
  }

  /**
   * Register the Anthropic-specific HTTP endpoints (Claude OAuth login
   * flow + `claude setup-token` shell-out) against the runner's
   * Express app. The runner invokes this via the generic
   * {@link PluginRuntime.registerHttpRoutes} hook at startup.
   */
  registerHttpRoutes(ctx: PluginHttpRoutesContext): void {
    registerAnthropicHttpRoutes(ctx)
  }

  // ── Executor surface ───────────────────────────────────────────────────────

  listModels(): ReadonlyArray<ExecutorModelDescriptor> {
    return ANTHROPIC_MODELS
  }

  /**
   * Default alias seed published to the runner. Workflows that
   * reference `model: 'planning'` / `model: 'coding'` resolve through
   * here when the tenant has not customised `settings.llm.aliases`.
   * The model ids match the values the runner historically synthesised
   * in `buildSettingsFromLocal`, so removing the runner-side defaults
   * is a no-op for tenants on the built-in Anthropic plugin.
   */
  defaultAliases(): Record<string, { provider: string; model: string }> {
    // Derived straight from {@link ANTHROPIC_MODELS} — the catalogue is
    // the single source of truth. Each tier default is the model tagged
    // `isDefault` for that tier (falling back to the first model of the
    // tier), so adding or retiring a catalogue entry updates these
    // aliases automatically. Workflow phases declare which tier they
    // want via `tier: planning|coding|mini`; tenants can rebind any tier
    // (`tier:planning`, etc.) from the dashboard without touching
    // workflow files.
    const tiers = tierDefaultAliases(ANTHROPIC_MODELS, ANTHROPIC_PLUGIN_ID)
    // Legacy two-tier shorthands (back-compat) so existing tenant
    // configs and custom workflows using `model: planning` keep working.
    const planning = tiers['tier:planning']
    const coding = tiers['tier:coding']
    return {
      ...tiers,
      ...(planning ? { planning } : {}),
      ...(coding ? { coding } : {}),
    }
  }

  /**
   * True for any model id that starts with `claude-`. We deliberately
   * accept models not listed in {@link listModels} (e.g. dated snapshots
   * like `claude-sonnet-4-5-20251022`) so workflow YAML can pin to a
   * specific revision without us having to ship a release of the
   * runner every time Anthropic publishes a new snapshot.
   */
  supports(model: string): boolean {
    return typeof model === 'string' && model.startsWith('claude-')
  }

  /**
   * Report a host sandbox that overrides our `sandbox: { enabled: false }`
   * request (see the note on that option in `executePhase`). Memoised: the
   * policy is read by the CLI at process start, so it cannot change
   * between phases of a running job, and this is called once per phase.
   */
  describeSandbox(): ExecutorSandboxReport | null {
    if (this.sandboxProbe === undefined) {
      this.sandboxProbe = probeHostSandbox()
      if (this.sandboxProbe) {
        this.logger.warn(
          {
            sources: this.sandboxProbe.sources,
            allowedDomains: this.sandboxProbe.allowedDomains?.length ?? null,
            excludedCommands: this.sandboxProbe.excludedCommands ?? [],
          },
          'Host policy enforces the Claude Code sandbox — Coro cannot disable it. ' +
            'Agent shell commands will be denied writes outside the job working directory. ' +
            'Amend the managed settings to relax this.',
        )
      }
    }
    return this.sandboxProbe
  }

  /**
   * Run a single workflow phase against the Claude Agent SDK.
   *
   * Owns:
   *   - SDK queryOptions construction (env, hooks, agents, MCP servers).
   *   - The bidirectional `pushable` that keeps stdin to the Claude Code
   *     subprocess open across model turns (so in-process MCP servers and
   *     mid-phase developer steering keep working).
   *   - Translation of raw SDK messages into provider-agnostic
   *     {@link PhaseExecutorEvent}s for the runner's bookkeeping loop.
   *   - Re-attachment of the Coro MCP server when resuming a session
   *     (the SDK is historically flaky there).
   *
   * Does NOT own:
   *   - Phase advancement, `goto_phase`, escalation, parking — the runner
   *     watches `req.signals` (via its tools) and stops consuming events
   *     once a control signal fires.
   *   - PhaseUsage construction / cost derivation — the runner combines
   *     the cumulative `usage` snapshot with its prePhase totals.
   *   - StateBackend writes — the runner is the only writer.
   */
  async *executePhase(req: PhaseExecutionRequest): AsyncIterable<PhaseExecutorEvent> {
    await this.assertAuthReadyForSdk()
    const claudeCodeCliPath = resolveClaudeCodeCliPath()
    ensureClaudeCodeCliExecutable(claudeCodeCliPath, this.logger)

    /** SDK spawns `cwd: req.cwd`. Missing dir reports as the (misleading) "cli.js not found" error. */
    mkdirSync(req.cwd, { recursive: true })
    ensureClaudeConfigSymlink(req.cwd, req.intelligenceDir, this.logger)

    // Translate the contract-level subagent specs into the SDK-shape
    // `agents` map. The runner pre-loads each subagent's prompt so the
    // executor doesn't need to know intelligence-dir layout.
    const agents = this.buildSdkAgentsFromRequest(req)

    // Hook policy → SDK PreToolUse hooks. The executor enforces tool
    // whitelist + write-root containment + bash safety — the runner
    // only declares the policy; the executor encodes it into the
    // SDK-native shape.
    // Build the dynamic MCP server map. `coro` is reserved for the
    // runner-supplied SDK server descriptor; plugin servers are merged
    // alongside (collisions on `coro` are blocked upstream by
    // collectPluginMcpServers, so casting is safe).
    const dynamicMcpServers: Record<string, McpServerConfig> = {
      coro: req.mcpServer.instance as unknown as McpServerConfig,
      ...(req.pluginMcpServers as unknown as Record<string, McpServerConfig>),
    }

    const rebuildMcpMap = (): Record<string, McpServerConfig> => {
      if (req.mcpRebuild) {
        const fresh = req.mcpRebuild()
        dynamicMcpServers.coro = fresh.instance as unknown as McpServerConfig
      }
      return dynamicMcpServers
    }

    let mcpTransportReady = true
    const hooks = buildPhaseHooks({
      liveJobRef: () => ({ phase: req.phase ?? 'unknown' }),
      workingDir: req.cwd,
      coroIntelligenceDir: req.intelligenceDir,
      allowedTools: req.hookPolicy.allowedTools ?? undefined,
      hookPolicy: req.hookPolicy,
      getMcpTransportReady: () => mcpTransportReady,
      logger: this.logger,
    })

    // Long-lived bidirectional input. The kickoff prompt is queued
    // immediately; the runner can push more SDKUserMessages via the
    // developerInput channel for the duration of the phase.
    const pushable = createPushableInput()
    pushable.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: req.userPrompt }] },
      parent_tool_use_id: null,
    })

    // Wire the developerInput channel so the runner-side bridge can
    // forward dispatcher steering messages into the live SDK stream.
    if (req.developerInput) {
      const channelClose = req.developerInput.close
      req.developerInput.push = (msg: ConversationMessage) => {
        const sdkMsg = (msg.meta?.['sdkUserMessage'] as SDKUserMessage | undefined) ?? toSdkUserMessage(msg)
        pushable.push(sdkMsg)
      }
      req.developerInput.close = () => {
        try { channelClose?.() } finally { pushable.close() }
      }
    }

    let mcpInputDead = false

    const resumeSessionId = req.sessionState.sessionId
    const queryOptions: Record<string, unknown> = {
      pathToClaudeCodeExecutable: claudeCodeCliPath,
      systemPrompt: req.systemPrompt,
      model: req.model,
      cwd: req.cwd,
      settingSources: ['project'],
      mcpServers: dynamicMcpServers,
      hooks,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      // Disable the Claude Code OS sandbox. As of claude-agent-sdk >=0.2.x the
      // CLI defaults to OS-level Bash sandboxing on macOS, which routes all
      // outbound traffic through a per-session proxy with a managed domain
      // allowlist. That allowlist excludes tenant infrastructure (private
      // NuGet/PyPI/npm registries like Nexus/Artifactory, self-hosted SCM,
      // observability endpoints), so `dotnet restore` / `pip install` / clones
      // fail with an opaque `blocked-by-allowlist` 403 that looks like a DNS or
      // auth error. Coro imposes no network allowlist of its own and enforces
      // filesystem confinement via its own PreToolUse path guard, so the SDK
      // sandbox is both redundant and actively harmful here.
      //
      // Caveat: the SDK forwards this as `--settings`, which lands in the
      // user-controlled *flag* settings layer. Enterprise-managed settings
      // (MDM, managed-settings.json, or org policy fetched from the server)
      // sit in the higher-priority *policy* layer and cannot be widened from
      // here, so on a managed host the sandbox may stay on regardless. Agents
      // recover via the `sandbox-recovery` skill; see base CLAUDE.md
      // "Two independent gates on Bash".
      sandbox: { enabled: false },
      maxTurns: req.maxTurns ?? 200,
      thinking: { type: 'adaptive' },
      systemPromptCacheControl: 'ephemeral',
      persistSession: true,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      env: {
        ...process.env,
        ...buildAnthropicAuthEnv(this.auth),
        BB_WORKSPACE: this.settings.bitbucket.workspace,
        BB_CODER_APP_PASSWORD: this.settings.bitbucket.coderAccount.appPassword,
        BB_BASE_URL: 'https://bitbucket.org',
        BB_GIT_USERNAME: this.settings.bitbucket.coderAccount.appPassword.startsWith('ATATT')
          ? 'x-bitbucket-api-token-auth'
          : encodeURIComponent(this.settings.bitbucket.coderAccount.username),
        GH_OWNER: this.settings.github?.owner ?? '',
        GH_TOKEN: this.settings.github?.token ?? '',
        CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '600000',
        // Tool search (deferred tool loading) is opt-in via
        // CORO_ENABLE_TOOL_SEARCH=1. When enabled, the Claude Code CLI
        // defers the mcp__coro__* tool schemas out of the model's tool
        // list and requires a ToolSearch round-trip to activate them.
        // In production this has caused phases to run with ZERO MCP
        // tool calls: the model loads schemas via ToolSearch but the
        // deferred tools never become invocable (observed on
        // haiku-tier campaign phases — the agent could not even call
        // `escalate` and burned the whole phase writing workaround
        // files). Coro's MCP tools are the agent's only channel for
        // state updates, artifacts, and escalation, so they must be
        // unconditionally present in the tool list by default.
        ...(process.env.CORO_ENABLE_TOOL_SEARCH === '1' || process.env.CORO_ENABLE_TOOL_SEARCH === 'true'
          ? { ENABLE_TOOL_SEARCH: 'true' }
          : {}),
        // Verbose SDK tracing is opt-in via CORO_DEBUG_CLAUDE_SDK=1.
        // Leaving it on by default floods the activity log with Bun
        // source frames whenever an AbortController fires inside the
        // SDK's control-request channel (e.g. tool-use aborts on
        // resume), which are caught internally and not real failures.
        ...(process.env.CORO_DEBUG_CLAUDE_SDK === '1' || process.env.CORO_DEBUG_CLAUDE_SDK === 'true'
          ? { DEBUG_CLAUDE_AGENT_SDK: '1' }
          : {}),
      },
      stderr: (chunk: string) => {
        const text = String(chunk).trim()
        if (!text) return
        for (const line of text.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          this.logger.debug({ phase: req.phase }, `[sdk-stderr] ${trimmed}`)
          // Bun source frames are SDK-internal stack noise; skip them
          // even when they incidentally match the filter below.
          if (isBunSourceFrameLine(trimmed)) continue
          // MCP / Transport / control_request lines are surfaced into
          // the job log via a `log` event so the runner can chunk them.
          if (/mcp|Transport|sdkMcp|control_request/i.test(trimmed)) {
            if (isMcpInputDeadText(trimmed)) mcpInputDead = true
            this._stderrBuffer.push(trimmed)
          }
        }
      },
    }

    if (agents) {
      queryOptions.agents = agents
    }

    const sdkAbortController = linkAbortController(req.signal)
    if (sdkAbortController) {
      queryOptions.abortController = sdkAbortController
    }

    // Cumulative phase totals. Anthropic emits per-turn assistant.usage
    // deltas plus a final canonical totals snapshot in `result`. The
    // executor accumulates internally and emits cumulative snapshots so
    // the runner doesn't need to know the difference.
    const cumulative: NormalizedTokensMutable = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    }
    let sessionId: string | undefined
    let stopReason = 'end_turn'
    let durationMs: number | undefined
    let durationApiMs: number | undefined
    let numTurns = 0
    let phaseTurns = 0
    let resultModelUsage: Record<string, NormalizedTokensMutable> | undefined
    let totalCostUsd: number | undefined

    const queryStream = query({
      prompt: pushable.iterable,
      options: queryOptions as Parameters<typeof query>[0]['options'],
    })

    // Capture the live Query handle and surface it through the
    // lifecycle controller so the runner / dispatcher can interrupt.
    //
    // `safe` steering skips interrupt while an MCP tool is in flight;
    // `urgent` interrupts (bounded ack) then schedules async MCP heal.
    const liveQuery = queryStream as Query
    let inFlightMcpTool: string | null = null
    let pendingInterruptHealLog: string | undefined
    let mcpHealInFlight = false
    let mcpHealQueued = false
    let mcpHealFailures = 0
    let lastMcpHealAt = 0
    let pendingMcpHealAfterSafeSteer = false
    const INTERRUPT_ACK_MS = 5_000

    const healOpts = () => ({
      liveQuery,
      dynamicMcpServers,
      forceReconnect: true as const,
      rebuildServers: req.mcpRebuild ? rebuildMcpMap : undefined,
    })

    const formatHealLog = (reason: string, refresh: Awaited<ReturnType<typeof healMcpTransport>>, ok: boolean) =>
      ok
        ? `[control] MCP re-attached (${reason}) — ` +
          `status=${refresh.finalStatus ?? 'unknown'} ` +
          `reconnected=${refresh.reconnected} ` +
          `errors=${JSON.stringify(refresh.setResult.errors)}` +
          (refresh.reconnectError ? ` reconnectError=${refresh.reconnectError}` : '')
        : `[control] MCP re-attach (${reason}) did not recover — ` +
          `status=${refresh.finalStatus ?? 'unknown'} ` +
          `errors=${JSON.stringify(refresh.setResult.errors)}` +
          (refresh.reconnectError ? ` reconnectError=${refresh.reconnectError}` : '')

    const pushMcpRetryNudge = (): void => {
      pushable.push({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: MCP_RETRY_NUDGE }],
        },
        parent_tool_use_id: null,
      })
    }

    const applyHealResult = (reason: string, refresh: Awaited<ReturnType<typeof healMcpTransport>>): boolean => {
      const errText = refresh.reconnectError ?? ''
      const ok = isCoroMcpHealthy(refresh) && !isMcpHealExhaustedError(errText)
      if (ok) {
        mcpHealFailures = 0
        pendingInterruptHealLog = formatHealLog(reason, refresh, true)
        if (reason === 'tool_result' || reason === 'interrupt' || reason === 'safe_steer') {
          pushMcpRetryNudge()
        }
      } else {
        mcpHealFailures += 1
        pendingInterruptHealLog = formatHealLog(reason, refresh, false)
      }
      return ok
    }

    const runMcpHealAsync = (reason: string): void => {
      if (mcpInputDead) {
        pendingInterruptHealLog =
          `[control] MCP heal skipped (${reason}) — control stream is closed; ` +
          `restart the job phase to restore MCP tools.`
        return
      }
      if (mcpHealFailures >= 3) {
        pendingInterruptHealLog =
          `[control] MCP heal skipped (${reason}) — prior heal attempts failed; ` +
          `wait for the next agent turn or restart the phase.`
        return
      }
      if (mcpHealInFlight) {
        mcpHealQueued = true
        return
      }
      mcpHealInFlight = true
      mcpTransportReady = false

      void (async () => {
        try {
          const refresh = await healMcpTransport(healOpts())
          applyHealResult(reason, refresh)
        } catch (err) {
          mcpHealFailures += 1
          const detail = err instanceof Error ? err.message : String(err)
          pendingInterruptHealLog = `[control] MCP re-attach (${reason}) failed: ${detail}`
        } finally {
          mcpTransportReady = true
          mcpHealInFlight = false
          lastMcpHealAt = Date.now()
          if (mcpHealQueued) {
            mcpHealQueued = false
            runMcpHealAsync('queued')
          }
        }
      })()
    }

    const scheduleMcpHeal = (reason: string, options?: { skipDebounce?: boolean }): void => {
      const now = Date.now()
      if (!options?.skipDebounce && now - lastMcpHealAt < 3_000) return
      runMcpHealAsync(reason)
    }

    const clearInFlightMcpTool = (): void => {
      inFlightMcpTool = null
      if (!pendingMcpHealAfterSafeSteer) return
      pendingMcpHealAfterSafeSteer = false
      scheduleMcpHeal('safe_steer', { skipDebounce: true })
    }

    const controller: ExecutorSessionController = {
      interrupt: async (options?: { mode?: SteeringInterruptMode }) => {
        const mode = options?.mode ?? 'urgent'
        if (mode === 'safe' && inFlightMcpTool) {
          pendingMcpHealAfterSafeSteer = true
          return
        }
        mcpTransportReady = false
        try {
          await Promise.race([
            liveQuery.interrupt(),
            new Promise<void>((_, reject) =>
              setTimeout(
                () => reject(new Error(`interrupt ack timeout after ${INTERRUPT_ACK_MS}ms`)),
                INTERRUPT_ACK_MS,
              ),
            ),
          ])
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          pendingInterruptHealLog = `[control] Steering interrupt did not ack — ${detail}`
        } finally {
          mcpTransportReady = true
        }
        if (mode === 'urgent') {
          scheduleMcpHeal('interrupt', { skipDebounce: true })
        }
      },
      getSteeringState: () => ({ inFlightMcpTool }),
    }
    req.lifecycle?.onSessionStart?.(controller)

    if (resumeSessionId) {
      try {
        const mcpRefresh = await reattachDynamicMcpServers(
          liveQuery,
          dynamicMcpServers,
          'coro',
          { forceReconnect: true },
        )
        this.logger.debug(
          {
            phase: req.phase,
            resumedFrom: resumeSessionId,
            added: mcpRefresh.setResult.added,
            removed: mcpRefresh.setResult.removed,
            errors: mcpRefresh.setResult.errors,
            reconnectError: mcpRefresh.reconnectError,
          },
          'Refreshed dynamic A5 MCP server on resumed query',
        )
        if (mcpRefresh.setResult.errors['coro'] || mcpRefresh.finalStatus === 'failed' || mcpRefresh.reconnectError) {
          yield {
            type: 'log',
            level: 'warn',
            message:
              `[warning] A5 MCP refresh reported issues on resumed session. ` +
              `errors=${JSON.stringify(mcpRefresh.setResult.errors)} ` +
              `status=${mcpRefresh.finalStatus ?? 'unknown'}` +
              (mcpRefresh.reconnectError ? ` reconnectError=${mcpRefresh.reconnectError}` : ''),
          }
        }
      } catch (err) {
        this.logger.warn(
          { err, phase: req.phase, resumedFrom: resumeSessionId },
          'Failed to refresh dynamic A5 MCP server on resumed query',
        )
        yield {
          type: 'log',
          level: 'warn',
          message:
            '[warning] Failed to refresh A5 MCP server on resumed session; MCP tools may be unavailable.',
        }
      }
    }

    // Latest `rate_limit_event` message observed from the Claude Code
    // subprocess. When the run subsequently throws (the SDK turns the
    // upstream rate-limit into a generic `Error("...You've hit your
    // limit · resets ...")`), we use this to compute a precise
    // `retryAfterMs` instead of falling back to the classifier's
    // 30-second default. `resetsAt` is epoch seconds, per the SDK.
    let latestRateLimitEvent: { resetsAt?: number; status?: string; rateLimitType?: string } | undefined

    try {
      for await (const raw of queryStream) {
        // Drain any buffered stderr lines as log events.
        while (this._stderrBuffer.length > 0) {
          yield { type: 'log', level: 'info', message: `[sdk-stderr] ${this._stderrBuffer.shift()!}` }
        }

        if (pendingInterruptHealLog) {
          const msg = pendingInterruptHealLog
          pendingInterruptHealLog = undefined
          yield {
            type: 'log',
            level: msg.includes('failed') ? 'warn' : 'info',
            message: msg,
          }
        }

        if (req.signal?.aborted) {
          try { await liveQuery.interrupt() } catch { /* best-effort */ }
          break
        }

        const message = raw as Record<string, unknown>
        const eventType = String(message['type'] ?? '')

        if (eventType === 'system') {
          const sid = message['session_id']
          if (typeof sid === 'string') {
            sessionId = sid
            yield { type: 'session_start', sessionId: sid }
          }
          if (message['subtype'] === 'init') {
            const mcpServers = Array.isArray(message['mcp_servers'])
              ? (message['mcp_servers'] as Array<{ name?: unknown; status?: unknown }>)
              : []
            const tools = Array.isArray(message['tools']) ? (message['tools'] as string[]) : []
            const mcpToolCount = tools.filter(
              t => typeof t === 'string' && t.startsWith('mcp__coro__'),
            ).length
            yield {
              type: 'log',
              level: 'info',
              message:
                `[init] session started — ${tools.length} tools at boot, ${mcpToolCount} mcp__coro__* tools` +
                (resumeSessionId ? ` (resumed from ${resumeSessionId})` : ''),
              meta: {
                mcpServersAtInit: mcpServers.map(s => ({ name: s.name, status: s.status })),
                totalToolsAtInit: tools.length,
                mcpToolCountAtInit: mcpToolCount,
                resumedFrom: resumeSessionId ?? null,
              },
            }
          }
          continue
        }

        if (eventType === 'assistant') {
          const betaMsg = message['message'] as Record<string, unknown> | undefined
          const content = betaMsg?.['content']
          if (Array.isArray(content)) {
            for (const block of content as Array<Record<string, unknown>>) {
              const bt = String(block['type'] ?? '')
              if (bt === 'text' && typeof block['text'] === 'string' && (block['text'] as string).trim()) {
                yield { type: 'text', content: block['text'] as string }
              } else if (bt === 'thinking' && typeof block['thinking'] === 'string') {
                yield { type: 'thinking', content: block['thinking'] as string }
              } else if (bt === 'tool_use' || bt === 'mcp_tool_use') {
                const toolName = String(block['name'] ?? 'unknown')
                const isMcp = toolName.startsWith('mcp__')
                if (isMcp) inFlightMcpTool = toolName
                yield {
                  type: 'tool_call',
                  toolName,
                  input: block['input'],
                  isMcp,
                }
              }
            }
          }

          const turnUsage = betaMsg?.['usage'] as Record<string, unknown> | undefined
          if (turnUsage) {
            cumulative.inputTokens += Number(turnUsage['input_tokens'] ?? 0)
            cumulative.outputTokens += Number(turnUsage['output_tokens'] ?? 0)
            cumulative.cacheReadInputTokens += Number(turnUsage['cache_read_input_tokens'] ?? 0)
            cumulative.cacheCreationInputTokens += Number(turnUsage['cache_creation_input_tokens'] ?? 0)
            phaseTurns++
            yield { type: 'usage', tokens: { ...cumulative } }
          }
          continue
        }

        // Self-heal: if a `user` event delivers a tool_result whose
        // content matches the well-known MCP-transport-corruption
        // patterns, schedule an unconditional reconnect for the next
        // iteration. This catches scenarios where the SDK's internal
        // request/response correlation gets desynced from sources
        // other than our own `interrupt()` (e.g. the SDK's own
        // background heartbeat, an unhandled control_request reject,
        // etc.). Without this the agent loses MCP tools for the rest
        // of the phase. With this it transparently retries.
        if (eventType === 'user') {
          clearInFlightMcpTool()
          const betaMsg = message['message'] as Record<string, unknown> | undefined
          const content = betaMsg?.['content']
          if (Array.isArray(content)) {
            for (const block of content as Array<Record<string, unknown>>) {
              if (block['type'] !== 'tool_result') continue
              if (block['is_error'] !== true) continue
              const rc = block['content']
              const text = typeof rc === 'string'
                ? rc
                : Array.isArray(rc)
                  ? (rc as Array<Record<string, unknown>>)
                      .map(c => typeof c['text'] === 'string' ? (c['text'] as string) : '')
                      .join(' ')
                  : ''
              if (isSteeringDiagnosticText(text)) {
                yield {
                  type: 'log',
                  level: 'info',
                  message:
                    `[control] Steering interrupt reflected in tool_result — ${text.slice(0, 300)}`,
                }
                break
              }
              if (isMcpTransportErrorText(text)) {
                if (isMcpInputDeadText(text)) mcpInputDead = true
                yield {
                  type: 'log',
                  level: 'warn',
                  message:
                    mcpInputDead
                      ? `[control] MCP control stream closed — setMcpServers cannot recover; restart the phase. detail=${text.slice(0, 200)}`
                      : `[control] MCP tool_result error detected — scheduling reconnect. detail=${text.slice(0, 200)}`,
                }
                if (!isMcpHealExhaustedError(text)) {
                  scheduleMcpHeal('tool_result')
                }
                break
              }
            }
          }
          // fall through to default handler swallow
        }

        if (eventType === 'tool_use_summary') {
          clearInFlightMcpTool()
          const summary = message['summary']
          if (typeof summary === 'string' && summary.trim()) {
            yield { type: 'log', level: 'info', message: `[tool_summary] ${summary}` }
          }
          continue
        }

        if (eventType === 'tool_progress') {
          const toolName = message['tool_name']
          const elapsed = message['elapsed_time_seconds']
          if (typeof toolName === 'string' && typeof elapsed === 'number' && elapsed >= 10) {
            yield {
              type: 'log',
              level: 'info',
              message: `⏳ ${toolName} running (${Math.round(elapsed)}s)`,
            }
          }
          continue
        }

        if (eventType === 'result') {
          const isError = message['is_error']
          let resultStopReason = stopReason
          if (isError) {
            const errors = message['errors']
            const errStr = Array.isArray(errors) ? (errors as string[]).join('; ') : 'unknown error'
            if (isSteeringDiagnosticText(errStr)) {
              resultStopReason = 'interrupted'
              yield {
                type: 'log',
                level: 'info',
                message: `[control] Recoverable steering interrupt — ${errStr.slice(0, 300)}`,
              }
            } else {
              resultStopReason = 'error'
              yield { type: 'log', level: 'error', message: `[error] ${errStr}` }
            }
          } else {
            const result = message['result']
            if (typeof result === 'string' && result.trim()) {
              yield { type: 'log', level: 'info', message: `[result] ${result}` }
            }
            const sr = message['stop_reason']
            // SDK may omit stop_reason on success; treat as natural completion.
            resultStopReason = typeof sr === 'string' ? sr : 'end_turn'
          }
          stopReason = resultStopReason

          const resultUsage = message['usage'] as Record<string, number> | undefined
          if (resultUsage) {
            cumulative.inputTokens = Number(resultUsage['input_tokens'] ?? cumulative.inputTokens)
            cumulative.outputTokens = Number(resultUsage['output_tokens'] ?? cumulative.outputTokens)
            cumulative.cacheReadInputTokens = Number(
              resultUsage['cache_read_input_tokens'] ?? cumulative.cacheReadInputTokens,
            )
            cumulative.cacheCreationInputTokens = Number(
              resultUsage['cache_creation_input_tokens'] ?? cumulative.cacheCreationInputTokens,
            )
          }
          if (typeof message['total_cost_usd'] === 'number') {
            totalCostUsd = message['total_cost_usd'] as number
          }
          if (typeof message['duration_ms'] === 'number') durationMs = message['duration_ms'] as number
          if (typeof message['duration_api_ms'] === 'number') durationApiMs = message['duration_api_ms'] as number
          if (typeof message['num_turns'] === 'number') numTurns = message['num_turns'] as number

          const rawModelUsage = message['modelUsage'] as Record<string, Record<string, unknown>> | undefined
          if (rawModelUsage) {
            resultModelUsage = Object.fromEntries(
              Object.entries(rawModelUsage).map(([m, u]) => [m, {
                inputTokens: Number(u['inputTokens'] ?? 0),
                outputTokens: Number(u['outputTokens'] ?? 0),
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
                totalCostUsd: Number(u['costUSD'] ?? 0),
              }]),
            )
          }

          // Final cumulative snapshot includes total cost (Anthropic-reported,
          // not yet derived — the runner runs derivePhaseCostUsd on top).
          yield {
            type: 'usage',
            tokens: { ...cumulative, ...(totalCostUsd !== undefined ? { totalCostUsd } : {}) },
            ...(resultModelUsage ? { modelUsage: resultModelUsage } : {}),
          }

          // Restore pre-steering-fix phase completion: close when the buffer
          // is empty so the query stream ends and the runner advances. Skip
          // only mid-phase stop reasons (steering interrupt / tool_use) that
          // must keep stdin open for subsequent MCP control_requests.
          if (pushable.isEmpty() && shouldClosePushableAfterResult(resultStopReason)) {
            pushable.close()
          }
          continue
        }

        const handledTypes = new Set(['system', 'assistant', 'tool_use_summary', 'tool_progress', 'result',
          'user', 'stream_event', 'auth_status'])
        if (eventType === 'rate_limit_event') {
          // Claude Code subprocess heads-up: the upstream rate-limit
          // budget for this account is rejecting (or about to reject)
          // requests. The SDK will subsequently throw a generic Error
          // when the next assistant turn fails; the catch below uses
          // `latestRateLimitEvent.resetsAt` to compute the exact wait.
          const info = (message['rate_limit_info'] ?? {}) as Record<string, unknown>
          latestRateLimitEvent = {
            resetsAt: typeof info['resetsAt'] === 'number' ? (info['resetsAt'] as number) : undefined,
            status: typeof info['status'] === 'string' ? (info['status'] as string) : undefined,
            rateLimitType: typeof info['rateLimitType'] === 'string' ? (info['rateLimitType'] as string) : undefined,
          }
          yield {
            type: 'log',
            level: latestRateLimitEvent.status === 'rejected' ? 'warn' : 'info',
            message:
              `[rate_limit] status=${latestRateLimitEvent.status ?? 'unknown'} ` +
              `type=${latestRateLimitEvent.rateLimitType ?? 'unknown'} ` +
              `resetsAt=${latestRateLimitEvent.resetsAt ?? 'unknown'}`,
          }
          continue
        }
        if (!handledTypes.has(eventType)) {
          yield {
            type: 'log',
            level: 'info',
            message: `[event:${eventType}] ${JSON.stringify(message)}`,
          }
        }
      }

      // Final 'done' event. Always emitted exactly once per executePhase
      // call so the runner can finalise PhaseUsage even when the SDK
      // never emitted a `result` (early break, transport crash).
      yield {
        type: 'done',
        stopReason,
        sessionState: { sessionId },
        metrics: {
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(durationApiMs !== undefined ? { durationApiMs } : {}),
          numTurns: numTurns || phaseTurns,
        },
      }
    } catch (err) {
      if (isRecoverableSteeringAbort(err)) {
        stopReason = 'interrupted'
        const detail = err instanceof Error ? err.message : String(err)
        yield {
          type: 'log',
          level: 'info',
          message: `[control] Recoverable steering interrupt — ${detail.slice(0, 300)}`,
        }
        yield {
          type: 'done',
          stopReason,
          sessionState: { sessionId },
          metrics: {
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(durationApiMs !== undefined ? { durationApiMs } : {}),
            numTurns: numTurns || phaseTurns,
          },
        }
      } else {
      // Classify provider rate-limit / overloaded errors so the runner
      // can park the job into STATUS_AWAITING_RATE_LIMIT and schedule
      // an auto-resume instead of treating it as a generic crash. All
      // other exceptions bubble untouched.
      //
      // Precedence:
      //   1. If we captured a `rate_limit_event` with `status: 'rejected'`
      //      from the Claude Code subprocess, the upstream session-level
      //      budget is exhausted. Build a RateLimitInfo from the
      //      authoritative `resetsAt` so the scheduler waits exactly
      //      until the budget resets (not the classifier's 30s default).
      //   2. If the SDK throws a plain `Error` whose message embeds the
      //      Claude Code subprocess rate-limit text (no status, no class,
      //      no headers), recognise it here — the generic provider-neutral
      //      classifier in `@coro-ai/plugin-sdk` deliberately doesn't know
      //      about subprocess-specific message shapes.
      //   3. Otherwise fall through to the generic classifier (HTTP
      //      status, header parse, SDK class detection).
      if (latestRateLimitEvent?.status === 'rejected' && typeof latestRateLimitEvent.resetsAt === 'number') {
        const retryAfterMs = Math.max(0, latestRateLimitEvent.resetsAt * 1000 - Date.now())
        const info = {
          kind: 'rate-limit' as const,
          retryAfterMs,
          source: 'reset-header' as const,
          message: typeof (err as { message?: unknown })?.message === 'string'
            ? ((err as { message: string }).message).slice(0, 500)
            : undefined,
        }
        this.logger.warn(
          { err, phase: req.phase, info, rateLimitEvent: latestRateLimitEvent },
          'Claude Code subprocess rate-limit (session budget) — escalating to runner park',
        )
        throw new RateLimitExceededError(ANTHROPIC_PLUGIN_ID, info, { cause: err })
      }
      if (isClaudeCodeRateLimitMessage(err)) {
        // Safety net: the stream-side `rate_limit_event` was missed
        // (different SDK build, stream cut early, etc.). Fall back to
        // the rate-limit default wait — the runner's RateLimitScheduler
        // applies exponential backoff per-attempt so repeated misses
        // ramp up the wait without us pretending to know the deadline.
        const info = {
          kind: 'rate-limit' as const,
          retryAfterMs: FALLBACK_CLAUDE_CODE_RATE_LIMIT_MS,
          source: 'fallback' as const,
          message: typeof (err as { message?: unknown })?.message === 'string'
            ? ((err as { message: string }).message).slice(0, 500)
            : undefined,
        }
        this.logger.warn(
          { err, phase: req.phase, info },
          'Claude Code subprocess rate-limit (message-pattern fallback) — escalating to runner park',
        )
        throw new RateLimitExceededError(ANTHROPIC_PLUGIN_ID, info, { cause: err })
      }
      const info = classifyProviderError(err, ANTHROPIC_CLASSIFY_OPTIONS)
      if (info) {
        this.logger.warn(
          { err, phase: req.phase, info },
          'Anthropic rate-limit / overloaded — escalating to runner park',
        )
        throw new RateLimitExceededError(ANTHROPIC_PLUGIN_ID, info, { cause: err })
      }
      throw err
      }
    } finally {
      if (pushable.isEmpty()) {
        pushable.close()
      }
      req.lifecycle?.onSessionEnd?.()
    }
  }

  /**
   * Translate the runner's pre-loaded {@link ExecutorSubagentSpec}s into
   * the Claude Agent SDK's `agents` map shape. Returns `undefined` when
   * no subagents are declared so the option key is omitted entirely.
   *
   * Subagents pinned to a non-Anthropic provider are skipped here — the
   * runner exposes them via the `mcp__coro__run_subagent` MCP tool
   * instead so they reach the right executor.
   *
   * MCP access is granted by *referencing* the parent session's
   * already-registered servers by name. The SDK's
   * `AgentDefinition.mcpServers` is an ARRAY of server names (or inline
   * records) — passing a bare `Record<name, config>` object map there
   * silently invalidates the whole agent definition, so the CLI drops
   * the agent and the model gets `Agent type '<name>' not found`. We
   * reference `coro` (so the subagent can call the `mcp__coro__*` tools
   * it declares) plus every plugin MCP server; the top-level
   * `mcpServers` option registers all of them under the same keys, so
   * the name references resolve.
   */
  private buildSdkAgentsFromRequest(
    req: PhaseExecutionRequest,
  ): Record<string, { description: string; prompt: string; tools?: string[]; model?: string; mcpServers?: string[] }> | undefined {
    if (!req.subagents || req.subagents.length === 0) return undefined
    const pluginServerNames = Object.keys(
      (req.pluginMcpServers as unknown as Record<string, McpServerConfig> | undefined) ?? {},
    )
    const mcpServerNames = ['coro', ...pluginServerNames]
    const out: Record<string, { description: string; prompt: string; tools?: string[]; model?: string; mcpServers?: string[] }> = {}
    for (const sa of req.subagents) {
      if (sa.provider && sa.provider !== ANTHROPIC_PLUGIN_ID) continue
      out[sa.name] = {
        description: `Subagent: ${sa.name}`,
        prompt: sa.systemPrompt,
        ...(sa.allowedTools ? { tools: [...sa.allowedTools] } : {}),
        ...(sa.model ? { model: sa.model } : {}),
        mcpServers: mcpServerNames,
      }
    }
    return Object.keys(out).length > 0 ? out : undefined
  }

  /**
   * Buffer for stderr-derived log lines. The SDK's `stderr` callback is
   * synchronous so we cannot `yield` from it directly — lines accumulate
   * here and are drained on the next iteration of the message loop.
   */
  private readonly _stderrBuffer: string[] = []

  /**
   * Optional MCP server descriptor — Anthropic does not bring its own
   * MCP server (it consumes the Coro server passed via PhaseExecutionRequest).
   */
  mcpServer(): PluginMcpServerConfig | undefined {
    return undefined
  }
}

// ── Factory (used by the runner's bootstrap path) ───────────────────────────

/**
 * Standard plugin factory shape. Mirrors the built-in SCM/tracker
 * factories so the bootstrap loop in `plugins/builtin/index.ts` can
 * wire the executor through the same path. Currently invoked from
 * runner/index.ts (not the built-in factory map) because the executor
 * needs `Settings` access — the built-in factory contract only carries
 * `config: Record<string, unknown>`. Phase 3 normalises this when the
 * executor moves out of the runner package.
 */
export function createAnthropicExecutor(opts: AnthropicExecutorOptions): AnthropicExecutor {
  return new AnthropicExecutor(opts)
}

function emptyNormalizedUsage(): NormalizedTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  }
}

function addUsage(a: NormalizedTokenUsage, b: NormalizedTokenUsage): NormalizedTokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
  }
}

function normalizeAnthropicUsage(usage?: {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}): NormalizedTokenUsage {
  return {
    inputTokens: Number(usage?.input_tokens ?? 0),
    outputTokens: Number(usage?.output_tokens ?? 0),
    cacheReadInputTokens: Number(usage?.cache_read_input_tokens ?? 0),
    cacheCreationInputTokens: Number(usage?.cache_creation_input_tokens ?? 0),
  }
}

function extractAnthropicText(
  content: Array<{ type: string; text?: string }>,
): string {
  return content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
