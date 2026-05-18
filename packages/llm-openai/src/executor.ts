import OpenAI from 'openai'
import type { Logger } from 'pino'
import type {
  ConversationMessage,
  ExecutorCapabilities,
  ExecutorModelDescriptor,
  ExecutorSessionController,
  HookPolicy,
  NormalizedTokenUsage,
  PhaseExecutionRequest,
  PhaseExecutorEvent,
  PhaseExecutorRuntime,
  PluginDeps,
  PluginHealth,
  PluginManifest,
  SubagentExecutionRequest,
  SubagentResult,
} from '@coro/plugin-sdk'
import {
  emptyNormalizedUsage,
  mergeConversationHistory,
  RateLimitExceededError,
  classifyProviderError,
} from '@coro/plugin-sdk'
import type { ClassifyOptions } from '@coro/plugin-sdk'
import { hasOpenAiApiKey, resolveOpenAiClientOptions } from './auth'
import { McpFunctionBridge, type OpenAiFunctionOutputItem, type OpenAiToolCall } from './mcp-bridge'
import { ExternalMcpConnectionPool } from './mcp-pool'
import {
  OPENAI_MODELS,
  OPENAI_PLUGIN_ID,
  calculateOpenAiCostUsd,
  supportsOpenAiModel,
} from './models'
import { openAiConfigSchema, type OpenAiAuthConfig, type OpenAiClientOptions } from './types'

interface OpenAiResponseUsageDetails {
  cached_tokens?: number
}

interface OpenAiResponseUsage {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: OpenAiResponseUsageDetails
}

interface OpenAiFunctionCallItem {
  type: 'function_call'
  call_id?: string
  id?: string
  name?: string
  arguments?: string
}

interface OpenAiOutputTextItem {
  type?: string
  content?: unknown
  text?: string
}

interface OpenAiResponseLike {
  id?: string
  output?: unknown[]
  output_text?: string
  usage?: OpenAiResponseUsage
  incomplete_details?: { reason?: string }
  status?: string
}

interface OpenAiResponsesClient {
  create(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<OpenAiResponseLike>
}

interface OpenAiClientLike {
  responses: OpenAiResponsesClient
}

export interface OpenAiExecutorOptions {
  auth?: OpenAiAuthConfig
  logger: Logger
  client?: OpenAiClientLike
  clientFactory?: (opts: OpenAiClientOptions) => OpenAiClientLike
}

const OPENAI_CAPABILITIES: ExecutorCapabilities = {
  supportsNativeSubagents: false,
  supportsClaudeMdNativeWalkUp: false,
  supportsNativeFileTools: false,
  supportsSessionResume: false,
  supportsConversationReplay: true,
  supportsThinking: true,
  supportsImageInput: true,
  maxContextTokens: 400_000,
}

export const OPENAI_MANIFEST: PluginManifest = {
  id: OPENAI_PLUGIN_ID,
  kind: 'executor',
  version: '1.0.0',
  displayName: 'OpenAI (Responses API)',
  hostCompatibility: '^1.0.0',
  configSchema: openAiConfigSchema,
  capabilities: {
    supportsResponsesApi: true,
  },
}

export class OpenAiExecutor implements PhaseExecutorRuntime<OpenAiAuthConfig> {
  readonly manifest = OPENAI_MANIFEST
  readonly kind = 'executor' as const
  readonly capabilities = OPENAI_CAPABILITIES

  private auth: OpenAiAuthConfig
  private readonly logger: Logger
  private readonly clientFactory: (opts: OpenAiClientOptions) => OpenAiClientLike
  private client?: OpenAiClientLike
  /**
   * Shared pool of external MCP connections, keyed by job working
   * directory + serverId. Reused across phases AND `run_subagent`
   * dispatches so we don't respawn stdio MCP children (e.g. Atlassian
   * FastMCP, GitHub MCP) for every side conversation.
   */
  private readonly externalMcpPool = new ExternalMcpConnectionPool()

  constructor(opts: OpenAiExecutorOptions) {
    this.auth = opts.auth ?? {}
    this.logger = opts.logger.child({ component: 'OpenAiExecutor' })
    this.client = opts.client
    this.clientFactory = opts.clientFactory ?? ((clientOpts) => new OpenAI(clientOpts) as unknown as OpenAiClientLike)
  }

  async init(config: unknown, _deps: PluginDeps): Promise<void> {
    const parsed = openAiConfigSchema.safeParse(config ?? {})
    if (!parsed.success) {
      this.logger.warn({ err: parsed.error.message }, 'OpenAI plugin config failed schema validation — keeping current auth')
      return
    }
    this.auth = parsed.data
    this.client = undefined
  }

  async healthcheck(): Promise<PluginHealth> {
    if (!hasOpenAiApiKey(this.auth)) {
      return { ok: false, reason: 'OpenAI API key is not configured. Set plugins.installed.openai.config.apiKey or OPENAI_API_KEY.' }
    }
    return { ok: true }
  }

  async dispose(): Promise<void> {
    this.client = undefined
    await this.externalMcpPool.drain()
  }

  listModels(): ReadonlyArray<ExecutorModelDescriptor> {
    return OPENAI_MODELS
  }

  supports(model: string): boolean {
    return supportsOpenAiModel(model)
  }

  calculateCost(model: string, usage: NormalizedTokenUsage): number {
    return calculateOpenAiCostUsd(model, usage)
  }

  defaultAliases(): Record<string, { provider: string; model: string }> {
    // The plugin owns only its own catalogue. We publish a default
    // model for each capability tier we expose; workflow phases declare
    // which tier they want via `tier: planning|coding|mini` and the
    // runner resolves through these aliases.
    //
    // Loader semantics (`seedExecutorDefaultAliases` in the runner) are
    // first-write-wins, so when both Anthropic and OpenAI are loaded,
    // Anthropic's `tier:*` defaults take precedence — OpenAI's tier
    // entries here only become active when Anthropic is absent or the
    // user has explicitly rebound the tier alias to OpenAI.
    //
    // The provider-prefixed `openai*` keys are kept for back-compat
    // and for users who want to pin a phase to OpenAI without changing
    // the global tier binding.
    const planning = { provider: OPENAI_PLUGIN_ID, model: 'gpt-5.5'        }
    const coding   = { provider: OPENAI_PLUGIN_ID, model: 'gpt-5.3-codex'  }
    const mini     = { provider: OPENAI_PLUGIN_ID, model: 'gpt-5.4-mini'   }
    return {
      'tier:planning': planning,
      'tier:coding':   coding,
      'tier:mini':     mini,
      openaiPlanning:  planning,
      openaiCoding:    coding,
      openaiMini:      mini,
    }
  }

  async *executePhase(req: PhaseExecutionRequest): AsyncIterable<PhaseExecutorEvent> {
    const health = await this.healthcheck()
    if (!health.ok) {
      yield { type: 'log', level: 'error', message: health.reason ?? 'OpenAI executor is not configured.' }
      yield { type: 'usage', tokens: emptyNormalizedUsage() }
      yield {
        type: 'done',
        stopReason: 'configuration_error',
        sessionState: { conversationHistory: req.sessionState.conversationHistory ?? [] },
        metrics: { numTurns: 0 },
      }
      return
    }

    const abortController = new AbortController()
    const controller: ExecutorSessionController = {
      interrupt: async () => abortController.abort(),
    }
    req.lifecycle?.onSessionStart?.(controller)

    const bridge = new McpFunctionBridge({
      coroServer: req.mcpServer,
      pluginServers: req.pluginMcpServers,
      hookPolicy: req.hookPolicy,
      cwd: req.cwd,
      phase: req.phase,
      signal: abortController.signal,
      externalPool: this.externalMcpPool,
      externalScopeKey: req.cwd,
    })
    await bridge.init()
    for (const failure of bridge.externalFailures) {
      yield {
        type: 'log',
        level: 'warn',
        message: `[openai] failed to attach external MCP server "${failure.serverId}": ${failure.reason}`,
      }
    }

    const tools = bridge.listTools()
    const history: ConversationMessage[] = []
    const inputItems: unknown[] = []
    inputItems.push(...conversationToOpenAiItems(req.sessionState.conversationHistory))
    const userItem = { role: 'user', content: req.userPrompt }
    inputItems.push(userItem)
    history.push({ role: 'user', content: req.userPrompt, meta: { openaiItems: [userItem] } })

    const client = this.getClient()
    let usage = emptyNormalizedUsage()
    let stopReason = 'end_turn'
    let turns = 0
    const start = Date.now()

    try {
      while (turns < req.maxTurns) {
        if (req.signal.aborted || abortController.signal.aborted) {
          stopReason = 'aborted'
          break
        }
        turns++
        let response: OpenAiResponseLike
        try {
          response = await client.responses.create(
            this.buildCreateParams(req, inputItems, tools),
            { signal: anySignal([req.signal, abortController.signal]) },
          )
        } catch (err) {
          // Interrupting the executor (e.g. when a developer-input
          // message is injected mid-flight, or the runner cancels)
          // aborts the in-flight Responses request, which throws an
          // AbortError. Treat that as a clean stop instead of crashing
          // the job — the runner will resume on the new context.
          if (isAbortError(err) || req.signal.aborted || abortController.signal.aborted) {
            stopReason = 'aborted'
            break
          }
          // Classify provider rate-limit / overloaded errors so the
          // runner can park into STATUS_AWAITING_RATE_LIMIT and
          // auto-resume rather than treating it as a crash.
          const info = classifyProviderError(err, OPENAI_CLASSIFY_OPTIONS)
          if (info) {
            this.logger.warn(
              { err, phase: req.phase, info },
              'OpenAI rate-limit / overloaded — escalating to runner park',
            )
            throw new RateLimitExceededError(OPENAI_PLUGIN_ID, info, { cause: err })
          }
          throw err
        }
        const outputItems = Array.isArray(response.output) ? response.output : []
        // With `store: false` the Responses API does NOT persist returned
        // items, so their server-generated IDs (e.g. `rs_*` reasoning
        // items, `msg_*` messages) cannot be referenced on subsequent
        // turns — replaying them as-is triggers `404 Item ... not
        // found`. Strip ephemeral IDs and drop `reasoning` items, which
        // OpenAI explicitly recommends removing in stateless mode.
        const replayItems = sanitizeOutputItemsForReplay(outputItems)
        inputItems.push(...replayItems)

        const text = extractOutputText(response)
        const toolCalls = extractFunctionCalls(outputItems)
        const assistantMessage: ConversationMessage = {
          role: 'assistant',
          content: text,
          ...(toolCalls.length > 0 ? {
            toolCalls: toolCalls.map(call => ({
              id: call.callId,
              name: call.name,
              input: safeJson(call.argumentsJson),
            })),
          } : {}),
          meta: {
            openaiResponseId: response.id,
            // Persist the sanitized items so session resume replay
            // never carries ephemeral server IDs back to the API.
            openaiItems: replayItems,
          },
        }
        history.push(assistantMessage)

        if (text.trim()) yield { type: 'text', content: text }
        const turnUsage = normalizeUsage(response.usage)
        usage = {
          inputTokens: usage.inputTokens + turnUsage.inputTokens,
          outputTokens: usage.outputTokens + turnUsage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens + turnUsage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens + turnUsage.cacheCreationInputTokens,
        }
        // Compute cumulative cost from our local pricing table. OpenAI's
        // Responses API does not return a dollar figure on the usage
        // payload (unlike Anthropic's `total_cost_usd` on the result
        // frame), so without this the runner sees `totalCostUsd=undefined`
        // on every usage event, `derivePhaseCostUsd` falls back to 0,
        // and every gpt-* phase shows $0.0000 in the dashboard.
        const totalCostUsd = calculateOpenAiCostUsd(req.model, usage)
        yield { type: 'usage', tokens: { ...usage, totalCostUsd } }

        if (toolCalls.length === 0) {
          stopReason = response.incomplete_details?.reason ?? response.status ?? 'end_turn'
          break
        }

        const toolOutputItems: OpenAiFunctionOutputItem[] = []
        for (const call of toolCalls) {
          const result = await bridge.call(call)
          toolOutputItems.push(result.item)
          for (const event of result.events) yield event
        }
        inputItems.push(...toolOutputItems)
        history.push({
          role: 'tool',
          content: toolOutputItems.map(item => item.output).join('\n'),
          toolResults: toolOutputItems.map(item => ({ toolCallId: item.call_id, output: item.output })),
          meta: { openaiItems: toolOutputItems },
        })
      }

      if (turns >= req.maxTurns && stopReason === 'end_turn') {
        stopReason = 'max_turns'
      }

      yield {
        type: 'done',
        stopReason,
        sessionState: {
          conversationHistory: mergeConversationHistory(
            req.sessionState.conversationHistory,
            history,
          ),
        },
        metrics: {
          durationMs: Date.now() - start,
          numTurns: turns,
        },
      }
    } finally {
      await bridge.dispose()
      req.lifecycle?.onSessionEnd?.()
    }
  }

  mcpServer(): undefined {
    return undefined
  }

  /**
   * Side-conversation runner used by the runner's `mcp__coro__run_subagent`
   * MCP tool. We deliberately reuse {@link executePhase} so the tool
   * loop, MCP bridge, hook enforcement, and usage accounting stay in
   * lock-step with regular phases — the subagent path is just a
   * stateless invocation with no session resume, no developer-input
   * channel, and a tightened tool allowlist.
   */
  async runSubagent(req: SubagentExecutionRequest): Promise<SubagentResult> {
    // The subagent's hook policy reuses the parent's write-roots and
    // pre-tool gate but narrows `allowedTools` to whatever the workflow
    // declared (or the runner's safe default — see tools/run-subagent.ts).
    const hookPolicy: HookPolicy = {
      ...req.hookPolicy,
      allowedTools: req.allowedTools,
    }

    const phaseReq: PhaseExecutionRequest = {
      systemPrompt: req.systemPrompt,
      userPrompt: req.task,
      model: req.model,
      ...(req.modelHints ? { modelHints: req.modelHints } : {}),
      cwd: req.cwd,
      intelligenceDir: req.intelligenceDir,
      mcpServer: req.mcpServer,
      pluginMcpServers: req.pluginMcpServers,
      hookPolicy,
      sessionState: { conversationHistory: [] },
      maxTurns: req.maxTurns,
      phase: `subagent:${req.name}`,
      signal: req.signal,
    }

    const collected: string[] = []
    let usage: NormalizedTokenUsage = emptyNormalizedUsage()
    let stopReason = 'end_turn'

    for await (const event of this.executePhase(phaseReq)) {
      if (event.type === 'text' && event.content) collected.push(event.content)
      else if (event.type === 'usage') usage = event.tokens
      else if (event.type === 'done') stopReason = event.stopReason
    }

    return {
      output: collected.join('\n').trim(),
      usage,
      stopReason,
    }
  }

  private getClient(): OpenAiClientLike {
    if (!this.client) {
      this.client = this.clientFactory(resolveOpenAiClientOptions(this.auth))
    }
    return this.client
  }

  private buildCreateParams(
    req: PhaseExecutionRequest,
    input: unknown[],
    tools: ReturnType<McpFunctionBridge['listTools']>,
  ): Record<string, unknown> {
    const params: Record<string, unknown> = {
      model: req.model || this.auth.defaultModel || 'gpt-5.4',
      instructions: req.systemPrompt,
      input,
      parallel_tool_calls: true,
      store: false,
    }
    if (tools.length > 0) params.tools = tools
    if (req.modelHints?.reasoningEffort) {
      params.reasoning = { effort: req.modelHints.reasoningEffort }
    }
    return params
  }
}

export function createOpenAiExecutor(opts: OpenAiExecutorOptions): OpenAiExecutor {
  return new OpenAiExecutor(opts)
}

function conversationToOpenAiItems(history: ReadonlyArray<ConversationMessage> | undefined): unknown[] {
  if (!history || history.length === 0) return []
  const out: unknown[] = []
  for (const message of history) {
    const nativeItems = message.meta?.['openaiItems']
    if (Array.isArray(nativeItems)) {
      out.push(...nativeItems)
      continue
    }
    if (message.role === 'user' || message.role === 'assistant' || message.role === 'system') {
      out.push({ role: message.role, content: message.content })
    }
    if (message.toolResults) {
      for (const result of message.toolResults) {
        out.push({
          type: 'function_call_output',
          call_id: result.toolCallId,
          output: stringifyUnknown(result.output),
        })
      }
    }
  }
  return out
}

function extractFunctionCalls(outputItems: unknown[]): OpenAiToolCall[] {
  const calls: OpenAiToolCall[] = []
  for (const raw of outputItems) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as OpenAiFunctionCallItem
    if (item.type !== 'function_call') continue
    if (!item.name) continue
    calls.push({
      callId: item.call_id ?? item.id ?? `${item.name}-${calls.length}`,
      name: item.name,
      argumentsJson: item.arguments ?? '{}',
    })
  }
  return calls
}

/**
 * The Responses API with `store: false` returns items whose IDs are
 * not persisted server-side. Replaying them on the next turn triggers
 * `404 Item ... not found`. We strip ephemeral IDs and drop reasoning
 * items entirely (OpenAI documents removal as the official remedy for
 * stateless mode). Function-call items keep their `call_id` because
 * that is the bridge between the model's request and our submitted
 * `function_call_output`; only the server-assigned `id` is dropped.
 */
function sanitizeOutputItemsForReplay(items: readonly unknown[]): unknown[] {
  const out: unknown[] = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const type = typeof item.type === 'string' ? item.type : undefined
    if (type === 'reasoning') continue
    const { id: _droppedId, ...rest } = item
    out.push(rest)
  }
  return out
}

function extractOutputText(response: OpenAiResponseLike): string {
  if (typeof response.output_text === 'string') return response.output_text
  const chunks: string[] = []
  for (const raw of response.output ?? []) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as OpenAiOutputTextItem
    if (typeof item.text === 'string') chunks.push(item.text)
    const content = item.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const text = (block as { text?: unknown }).text
        if (typeof text === 'string') chunks.push(text)
      }
    }
  }
  return chunks.join('\n')
}

function normalizeUsage(usage: OpenAiResponseUsage | undefined): NormalizedTokenUsage {
  return {
    inputTokens: Number(usage?.input_tokens ?? 0),
    outputTokens: Number(usage?.output_tokens ?? 0),
    cacheReadInputTokens: Number(usage?.input_tokens_details?.cached_tokens ?? 0),
    cacheCreationInputTokens: 0,
  }
}

function safeJson(json: string): unknown {
  try { return JSON.parse(json || '{}') } catch { return json }
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  const abort = () => controller.abort()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener('abort', abort, { once: true })
  }
  return controller.signal
}

/**
 * `client.responses.create` rejects with an AbortError / DOMException
 * when its signal is aborted. Recognise the common shapes so the
 * executor can treat interruption as a clean stop instead of crashing
 * the job. The OpenAI SDK forwards the underlying fetch's
 * DOMException (`name === 'AbortError'`, `code === 20`); native
 * `AbortController` produces the same shape.
 */
function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: unknown; code?: unknown }
  return e.name === 'AbortError' || e.code === 20 || e.code === 'ABORT_ERR'
}

/**
 * OpenAI-specific extensions for the shared
 * {@link classifyProviderError} helper. Keeps vendor-specific
 * detection isolated to this package so `@coro/plugin-sdk` can stay
 * provider-neutral.
 */
const OPENAI_CLASSIFY_OPTIONS: ClassifyOptions = {
  // The official OpenAI SDK throws `RateLimitError` subclasses when
  // the API returns 429. We match by class/name because some
  // transports drop the HTTP status by the time the error reaches us.
  detectRateLimit: (err: unknown): boolean => {
    if (!err || typeof err !== 'object') return false
    const e = err as Record<string, unknown>
    if (typeof e.name === 'string' && e.name === 'RateLimitError') return true
    const ctor = (e as { constructor?: { name?: string } }).constructor
    return ctor?.name === 'RateLimitError'
  },
  // OpenAI uses `x-ratelimit-reset-{tokens,requests}` (duration string
  // like `6m12s`). Tokens are listed first because token quota is what
  // an agent typically exhausts mid-phase; `extractRetryHint` picks
  // the largest matching wait anyway, so order is documentation only.
  extraResetHeaders: [
    'x-ratelimit-reset-tokens',
    'x-ratelimit-reset-requests',
  ],
}
