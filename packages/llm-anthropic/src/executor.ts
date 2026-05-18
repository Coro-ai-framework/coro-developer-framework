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
  ConversationMessage,
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
} from '@coro/plugin-sdk'
import { buildAnthropicAuthEnv } from './auth'
import { registerAnthropicHttpRoutes } from './http-routes'
import { buildPhaseHooks } from './hooks'
import { createPushableInput } from './pushable'
import { ensureClaudeConfigSymlink } from './intelligence-symlink'
import { reattachDynamicMcpServers } from './mcp-reattach'
import type { AnthropicExecutorSettings, ClaudeAuthConfig } from './types'

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
  // Current generation (4.6/4.7) — dateless IDs are pinned snapshots,
  // not evergreen pointers. Source: platform.claude.com/docs models overview.
  {
    id: 'claude-opus-4-7',
    displayName: 'Claude Opus 4.7',
    contextTokens: 1_000_000,
    tier: 'planning',
    supportsThinking: true,
    pricing: { inputPerMTokens: 15, outputPerMTokens: 75, cacheReadPerMTokens: 1.5 },
  },
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    contextTokens: 1_000_000,
    tier: 'coding',
    supportsThinking: true,
    pricing: { inputPerMTokens: 3, outputPerMTokens: 15, cacheReadPerMTokens: 0.3 },
  },
  {
    id: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    contextTokens: 200_000,
    tier: 'mini',
    supportsThinking: true,
    pricing: { inputPerMTokens: 0.8, outputPerMTokens: 4, cacheReadPerMTokens: 0.08 },
  },
  // Previous generation — kept available for cost/latency tuning and
  // for tenants that have pinned older IDs in their workflow front matter.
  {
    id: 'claude-sonnet-4-5',
    displayName: 'Claude Sonnet 4.5',
    contextTokens: 200_000,
    tier: 'coding',
    supportsThinking: true,
    pricing: { inputPerMTokens: 3, outputPerMTokens: 15, cacheReadPerMTokens: 0.3 },
  },
  {
    id: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    contextTokens: 200_000,
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
    /**
     * The dashboard renders {@link AnthropicAuthPanel} (claude-login
     * + api-key + legacy oauth) instead of the schema-driven form,
     * because Anthropic auth is an OAuth flow rather than a flat
     * key/value config.
     */
    customPanel: 'anthropic-auth',
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
    // `claudeLogin` defers to Claude Code's persisted session — nothing
    // to verify in-process; it either works on first call or doesn't.
    return { ok: true }
  }

  async dispose(): Promise<void> {
    // The Claude Agent SDK owns its own subprocess lifecycle and tears
    // down on stream close. Nothing executor-owned to release here.
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
    // The plugin only owns its own catalogue. We publish a default
    // model for each capability tier we expose via
    // {@link ANTHROPIC_MODELS}; workflow phases declare which tier
    // they want via `tier: planning|coding|mini` and the runner
    // resolves through these aliases. Tenants can rebind any tier
    // (`tier:planning`, etc.) from the dashboard without touching
    // workflow files.
    //
    // The legacy `planning` / `coding` keys are kept so existing
    // tenant configs and any custom workflow files still using
    // `model: planning` keep working unchanged.
    const opus    = { provider: ANTHROPIC_PLUGIN_ID, model: 'claude-opus-4-6'   }
    const sonnet  = { provider: ANTHROPIC_PLUGIN_ID, model: 'claude-sonnet-4-6' }
    const haiku   = { provider: ANTHROPIC_PLUGIN_ID, model: 'claude-haiku-4-5'  }
    return {
      // Tier defaults — the only vocabulary the plugin owns.
      'tier:planning': opus,
      'tier:coding':   sonnet,
      'tier:mini':     haiku,
      // Legacy two-tier shorthands (back-compat).
      planning: opus,
      coding:   sonnet,
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
    const hooks = buildPhaseHooks({
      // The hook only reads phase for log context; we surface whatever
      // the runner labelled the request with.
      liveJobRef: () => ({ phase: req.phase ?? 'unknown' }),
      workingDir: req.cwd,
      coroIntelligenceDir: req.intelligenceDir,
      allowedTools: req.hookPolicy.allowedTools ?? undefined,
      logger: this.logger,
    })

    // Build the dynamic MCP server map. `coro` is reserved for the
    // runner-supplied SDK server descriptor; plugin servers are merged
    // alongside (collisions on `coro` are blocked upstream by
    // collectPluginMcpServers, so casting is safe).
    const dynamicMcpServers: Record<string, McpServerConfig> = {
      coro: req.mcpServer.instance as unknown as McpServerConfig,
      ...(req.pluginMcpServers as unknown as Record<string, McpServerConfig>),
    }

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
        ENABLE_TOOL_SEARCH: 'true',
        DEBUG_CLAUDE_AGENT_SDK: '1',
      },
      stderr: (chunk: string) => {
        const text = String(chunk).trim()
        if (!text) return
        for (const line of text.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          this.logger.debug({ phase: req.phase }, `[sdk-stderr] ${trimmed}`)
          // MCP / Transport / control_request lines are surfaced into
          // the job log via a `log` event so the runner can chunk them.
          if (/mcp|Transport|sdkMcp|control_request/i.test(trimmed)) {
            // Buffered into the per-iteration emit below — see _stderrBuffer.
            this._stderrBuffer.push(trimmed)
          }
        }
      },
    }

    if (agents) {
      queryOptions.agents = agents
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
    // Calling `q.interrupt()` while an MCP tool call is in flight
    // leaves the SDK<->subprocess MCP transport in a degraded state:
    // pending control_request entries get aborted, and subsequent
    // `mcp__coro__*` calls fail with `Request aborted` / `Stream closed`
    // until the dynamic MCP server is re-attached. We set a flag here
    // and trigger a re-attach on the next for-await iteration so the
    // dispatcher's pause + steering interrupts don't break MCP for the
    // remainder of the phase.
    const liveQuery = queryStream as Query
    let mcpReconnectPending = false
    const controller: ExecutorSessionController = {
      interrupt: () => {
        mcpReconnectPending = true
        return liveQuery.interrupt()
      },
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
        if (mcpRefresh.setResult.errors['a5'] || mcpRefresh.finalStatus === 'failed' || mcpRefresh.reconnectError) {
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

    try {
      for await (const raw of queryStream) {
        // Drain any buffered stderr lines as log events.
        while (this._stderrBuffer.length > 0) {
          yield { type: 'log', level: 'info', message: `[sdk-stderr] ${this._stderrBuffer.shift()!}` }
        }

        // Re-attach dynamic MCP servers after a controller-initiated
        // interrupt so the agent's next `mcp__coro__*` call lands on a
        // healthy transport. See the comment above `liveQuery` for why.
        if (mcpReconnectPending) {
          mcpReconnectPending = false
          try {
            // `forceReconnect: true` — the SDK reports status='connected'
            // after an interrupt even when the request/response
            // correlation table is corrupted. Always rebuild the
            // transport so the next `mcp__coro__*` call lands on a
            // freshly-handshaked channel.
            const refresh = await reattachDynamicMcpServers(
              liveQuery,
              dynamicMcpServers,
              'coro',
              { forceReconnect: true },
            )
            yield {
              type: 'log',
              level: refresh.reconnectError ? 'warn' : 'info',
              message:
                `[control] MCP re-attached after interrupt — ` +
                `status=${refresh.finalStatus ?? 'unknown'} ` +
                `reconnected=${refresh.reconnected} ` +
                `errors=${JSON.stringify(refresh.setResult.errors)}` +
                (refresh.reconnectError ? ` reconnectError=${refresh.reconnectError}` : ''),
            }
          } catch (err) {
            yield {
              type: 'log',
              level: 'warn',
              message: `[control] MCP re-attach after interrupt failed: ${String(err)}`,
            }
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
                yield {
                  type: 'tool_call',
                  toolName,
                  input: block['input'],
                  isMcp: toolName.startsWith('mcp__'),
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
              if (/stream closed|request aborted|mcp(?:\s+|.*)(?:error|closed|disconnected)|connection closed/i.test(text)) {
                // Eager reattach. The previous lazy implementation
                // flipped `mcpReconnectPending` and waited for the
                // next loop iteration to rebuild the transport, but
                // if the failing tool_result was the last item in
                // the agent's turn (stop_reason=tool_use, no
                // follow-up message) the loop would block on
                // `for await` forever and the reattach would never
                // run. Do it inline so the transport is healed
                // before we even yield the warning.
                yield {
                  type: 'log',
                  level: 'warn',
                  message: `[control] MCP tool_result error detected — reconnecting now. detail=${text.slice(0, 200)}`,
                }
                try {
                  const refresh = await reattachDynamicMcpServers(
                    liveQuery,
                    dynamicMcpServers,
                    'coro',
                    { forceReconnect: true },
                  )
                  yield {
                    type: 'log',
                    level: refresh.reconnectError ? 'warn' : 'info',
                    message:
                      `[control] MCP re-attached after tool_result error — ` +
                      `status=${refresh.finalStatus ?? 'unknown'} ` +
                      `reconnected=${refresh.reconnected} ` +
                      `errors=${JSON.stringify(refresh.setResult.errors)}` +
                      (refresh.reconnectError ? ` reconnectError=${refresh.reconnectError}` : ''),
                  }
                  // Tell the agent the failure was transient so it
                  // retries instead of replanning around the error
                  // (which is what it would otherwise do — we have
                  // logs of agents inventing GOPROXY=direct
                  // workarounds after a single MCP transport blip).
                  //
                  // Gate on the correct success signal: `setMcpServers`
                  // returning no error for our server AND the SDK
                  // reporting transport=connected (or null, meaning
                  // status-unknown — common right after re-registration
                  // for SDK-type servers). DO NOT gate on
                  // `refresh.reconnected`: for in-process SDK servers
                  // like our `coro` MCP server, `reconnectMcpServer`
                  // is a no-op rejected by the SDK with
                  // "SDK servers should be handled in print.ts", so
                  // `reconnected` is structurally always false for
                  // our setup and gating on it leaves the agent
                  // hanging on a closed stream forever.
                  const coroErrored = Boolean(refresh.setResult.errors['coro'])
                  const transportOk = refresh.finalStatus === 'connected' || refresh.finalStatus === null
                  if (!coroErrored && transportOk) {
                    pushable.push({
                      type: 'user',
                      message: {
                        role: 'user',
                        content: [{
                          type: 'text',
                          text:
                            '[system notice] Your previous tool call failed because the MCP transport ' +
                            'was reset (typically by a developer steering interrupt or a transient SDK ' +
                            'race). The connection has been rebuilt and is healthy. Retry the exact same ' +
                            'tool call — do NOT change your plan or invent workarounds based on this failure.',
                        }],
                      },
                      parent_tool_use_id: null,
                    })
                  }
                } catch (err) {
                  yield {
                    type: 'log',
                    level: 'warn',
                    message: `[control] MCP re-attach after tool_result error failed: ${String(err)}`,
                  }
                }
                break
              }
            }
          }
          // fall through to default handler swallow
        }

        if (eventType === 'tool_use_summary') {
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
          if (isError) {
            stopReason = 'error'
            const errors = message['errors']
            const errStr = Array.isArray(errors) ? (errors as string[]).join('; ') : 'unknown error'
            yield { type: 'log', level: 'error', message: `[error] ${errStr}` }
          } else {
            const result = message['result']
            if (typeof result === 'string' && result.trim()) {
              yield { type: 'log', level: 'info', message: `[result] ${result}` }
            }
            const sr = message['stop_reason']
            if (typeof sr === 'string') stopReason = sr
          }

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

          // Close the streaming-input pushable so the SDK's outer iterator
          // ends — but ONLY when the input buffer is empty. In streaming-
          // input mode the SDK awaits more user messages after every
          // `result`; if we close unconditionally we drop steering messages
          // that were pushed while the agent was mid-turn (the dispatcher
          // queues them and calls `q.interrupt()`, which itself produces a
          // `result` event). When the buffer holds a queued message we
          // leave the pushable open so the SDK reads it on its next
          // iteration; the agent will emit another `result` when that
          // follow-up turn ends, and we'll re-evaluate then.
          if (pushable.isEmpty()) {
            pushable.close()
          }
          continue
        }

        const handledTypes = new Set(['system', 'assistant', 'tool_use_summary', 'tool_progress', 'result',
          'user', 'stream_event', 'auth_status'])
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
    } finally {
      pushable.close()
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
   */
  private buildSdkAgentsFromRequest(
    req: PhaseExecutionRequest,
  ): Record<string, { description: string; prompt: string; tools?: string[]; model?: string; mcpServers?: Record<string, McpServerConfig> }> | undefined {
    if (!req.subagents || req.subagents.length === 0) return undefined
    const subagentMcpServers = req.pluginMcpServers as unknown as Record<string, McpServerConfig>
    const out: Record<string, { description: string; prompt: string; tools?: string[]; model?: string; mcpServers?: Record<string, McpServerConfig> }> = {}
    for (const sa of req.subagents) {
      if (sa.provider && sa.provider !== ANTHROPIC_PLUGIN_ID) continue
      out[sa.name] = {
        description: `Subagent: ${sa.name}`,
        prompt: sa.systemPrompt,
        ...(sa.allowedTools ? { tools: [...sa.allowedTools] } : {}),
        ...(sa.model ? { model: sa.model } : {}),
        ...(Object.keys(subagentMcpServers).length > 0 ? { mcpServers: subagentMcpServers } : {}),
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
