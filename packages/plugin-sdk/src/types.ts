// ── Plugin SDK types ─────────────────────────────────────────────────────────
//
// Public, authoring-side mirror of the runner's `plugins/types.ts`. We
// deliberately *duplicate* (rather than re-export from `@coro/runner`)
// so:
//
//   1. Drop-in plugin authors can install `@coro/plugin-sdk` without
//      pulling the entire runner (which carries `simple-git`,
//      `better-sqlite3`, the Claude SDK, etc.) into their dependency
//      tree.
//   2. The runner's internal types stay free to evolve without breaking
//      published plugins; SDK type changes are governed by
//      `HOST_PLUGIN_API_VERSION` + the v1.5 loader's
//      `hostCompatibility` check.
//
// Keep this file behaviourally identical to the runner's types — every
// drift is a potential interop bug. The conformance test pack at
// `packages/runner/tests/plugins/conformance.test.ts` uses the runner
// types; plugin authors importing from here must satisfy the same
// surface.
//
// Note: `ExternalRef`, `ExternalRefKind`, and `NormalizedEvent` used
// to be declared here as a deliberate duplicate of the runner's
// `plugins/refs.ts`. They now live in `@coro/cloud-protocol` — the
// shared wire-contract package depended on by runner, cloud, and SDK
// alike — so there is exactly one canonical definition. Plugin
// authors import them directly from `@coro/cloud-protocol`.

import type { Logger } from 'pino'
import type { ZodTypeAny } from 'zod'
import type { ConversationMessage, ExternalRef, NormalizedEvent } from '@coro/cloud-protocol'

// Re-export `ConversationMessage` so plugin authors authoring an
// executor can import it from `@coro/plugin-sdk` alongside the rest of
// the executor contract (`ExecutorSessionState`, `PhaseExecutorRuntime`,
// etc.). The canonical definition lives in `@coro/cloud-protocol`
// because it's part of the persisted `Job.conversationHistory` wire shape.
export type { ConversationMessage } from '@coro/cloud-protocol'

// ── External MCP server descriptor ──────────────────────────────────────────

export interface PluginMcpStdioServerConfig {
  type: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface PluginMcpSseServerConfig {
  type: 'sse'
  url: string
  headers?: Record<string, string>
}

export interface PluginMcpHttpServerConfig {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

export type PluginMcpServerConfig =
  | PluginMcpStdioServerConfig
  | PluginMcpSseServerConfig
  | PluginMcpHttpServerConfig

// ── Manifest ────────────────────────────────────────────────────────────────

export type PluginKind = 'scm' | 'tracker' | 'executor' | (string & {})

export interface PluginWebhookDescriptor {
  pathSuffix?: string
  algorithm: 'hmac-sha256' | 'hmac-sha1' | 'none'
  header: string
  format: 'sha256=<hex>' | 'sha1=<hex>' | '<hex>' | '<plain>'
}

export interface PluginIntelligenceContribution {
  skills?: ReadonlyArray<{ id: string; relativePath: string }>
  snippets?: ReadonlyArray<{ id: string; relativePath: string }>
}

export interface PluginManifest {
  id: string
  kind: PluginKind
  version: string
  displayName: string
  /** Semver range against the runner's `HOST_PLUGIN_API_VERSION`. */
  hostCompatibility: string
  configSchema: ZodTypeAny
  capabilities?: Record<string, boolean>
  webhook?: PluginWebhookDescriptor
  intelligence?: PluginIntelligenceContribution
  mcpToolMap?: Record<string, string>
  allowedMcpTools?: ReadonlyArray<string>
  disallowedMcpTools?: ReadonlyArray<string>
  /**
   * Optional UI override for the dashboard. When `customPanel` is set,
   * the dashboard's plugin card delegates to a registered React
   * component instead of rendering the schema-driven form. Used by
   * providers (e.g. Anthropic) whose configuration is an OAuth flow
   * rather than a flat key/value list.
   */
  ui?: {
    customPanel?: string
  }
}

// ── Runtime contract ─────────────────────────────────────────────────────────

export interface PluginDeps {
  logger: Logger
  fetch: typeof fetch
}

export interface PluginHealth {
  ok: boolean
  reason?: string
}

/**
 * Minimal route-registration surface a plugin can hang HTTP endpoints
 * off of. Structurally compatible with `express.Express` (and
 * `Router`) so plugins can cast to the full express type if they need
 * middleware, but plugin-sdk itself takes no dependency on express.
 */
export interface PluginHttpApp {
  get(path: string, ...handlers: Array<(...args: unknown[]) => unknown>): unknown
  post(path: string, ...handlers: Array<(...args: unknown[]) => unknown>): unknown
  put(path: string, ...handlers: Array<(...args: unknown[]) => unknown>): unknown
  delete(path: string, ...handlers: Array<(...args: unknown[]) => unknown>): unknown
}

/**
 * Context passed to {@link PluginRuntime.registerHttpRoutes}. The
 * runner injects an Express app, a logger, and a couple of helpers
 * for plugins that need to persist their own credentials or redact
 * secrets when echoing them back to the dashboard.
 *
 * `saveLocalConfig` is intentionally typed as a record patch — the
 * runner owns the on-disk config schema; plugins just hand it
 * deeply-nested values keyed by their own namespace.
 *
 * `savePluginConfig` is a namespaced helper for the common case of a
 * plugin persisting its own config slot under
 * `plugins.installed[pluginId].config`. The runner deep-merges the
 * patch into the existing slot so concurrent updates from different
 * plugins don't clobber each other.
 */
export interface PluginHttpRoutesContext {
  app: PluginHttpApp
  logger: Logger
  saveLocalConfig: (patch: Record<string, unknown>) => void
  savePluginConfig: (pluginId: string, configPatch: Record<string, unknown>) => void
  redactSecret: (value: string | undefined | null) => string
}

export interface PluginRuntime<Config = unknown> {
  manifest: PluginManifest
  init(config: Config, deps: PluginDeps): Promise<void>
  healthcheck(): Promise<PluginHealth>
  dispose(): Promise<void>
  intelligenceRoot?(): string | undefined
  mcpServer?(): PluginMcpServerConfig | undefined
  /**
   * Optional Express route registration. Called once at runner
   * startup after the plugin registry is built. Plugins use this for
   * provider-specific OAuth callbacks, dashboard previews, etc.
   * Routes registered here become first-class endpoints on the
   * runner's HTTP server alongside the built-in routes.
   */
  registerHttpRoutes?(ctx: PluginHttpRoutesContext): void
}

// ── SCM plugin ───────────────────────────────────────────────────────────────

export interface ScmCloneInfo {
  url: string
  envForGit: Record<string, string>
}

export interface ScmCreateRepoArgs {
  repoSlug: string
  description?: string
  isPrivate?: boolean
  defaultBranch?: string
}

export interface ScmCreatePrArgs {
  repoSlug: string
  title: string
  description?: string
  sourceBranch: string
  targetBranch?: string
  reviewers?: ReadonlyArray<string>
}

export interface ScmPrComment {
  id: string
  body: string
  createdAt: string
  updatedAt: string
  parentId?: string
  author?: string
  inline?: { path: string; line?: number }
}

export interface ScmPrStatus {
  state: 'open' | 'merged' | 'declined' | 'superseded'
  approvalCount: number
  commentCount?: number
  url?: string
}

export interface ScmMergeOptions {
  message?: string
  strategy?: 'merge' | 'squash' | 'rebase'
}

export interface ScmPollSnapshot {
  state: ScmPrStatus['state']
  approvalCount: number
  commentCount: number
  comments: ReadonlyArray<ScmPrComment>
}

export interface ScmPluginRuntime<Config = unknown> extends PluginRuntime<Config> {
  kind: 'scm'

  // Required even in MCP mode — credentialed clone URLs and host checks
  // have no MCP equivalent.
  cloneInfo(args: { repo: string }): ScmCloneInfo
  matchesRemote(remoteUrl: string): boolean

  // Polling runs OUTSIDE an active query() session so it cannot use the
  // upstream MCP server. Plugins keep a tiny native fetch for this.
  pollPr(ref: ExternalRef): Promise<ScmPollSnapshot>

  // Optional after the MCP-first pivot: plugins serving the operation
  // through their MCP server omit the method.
  createRepo?(args: ScmCreateRepoArgs): Promise<ExternalRef>
  createPr?(args: ScmCreatePrArgs): Promise<ExternalRef>
  getPrStatus?(ref: ExternalRef): Promise<ScmPrStatus>
  listPrComments?(ref: ExternalRef): Promise<ScmPrComment[]>
  postPrComment?(ref: ExternalRef, body: string): Promise<ScmPrComment>
  replyToComment?(ref: ExternalRef, parentId: string, body: string): Promise<ScmPrComment>
  approvePr?(ref: ExternalRef): Promise<void>
  mergePr?(ref: ExternalRef, opts?: ScmMergeOptions): Promise<void>

  /**
   * Self-improvement writer escape hatch — runs OUTSIDE `query()` and
   * cannot reach the MCP server. MCP-mode plugins must keep a tiny
   * native PR-creation path for this single use case.
   */
  writerCreatePr?(args: ScmCreatePrArgs): Promise<ExternalRef>

  /**
   * Plugin-driven webhook normalisation. Returns null when the request
   * is not interesting to this plugin (irrelevant event, unparseable
   * body, etc.).
   */
  normalizeInbound?(req: {
    headers: Record<string, string | string[] | undefined>
    rawBody: Buffer
  }): NormalizedEvent | null
}

// ── Tracker plugin ───────────────────────────────────────────────────────────

export interface TrackerIssue {
  key: string
  title: string
  status: string
  url?: string
  description?: string
  parentKey?: string
  labels?: ReadonlyArray<string>
}

export interface TrackerCommentArgs {
  key: string
  body: string
}

export interface TrackerTransitionArgs {
  key: string
  /** Status name, not numeric transition id (plugin handles the lookup). */
  status: string
}

export interface TrackerPluginRuntime<Config = unknown> extends PluginRuntime<Config> {
  kind: 'tracker'

  // All read/write methods are optional after the MCP-first pivot —
  // MCP-mode plugins delegate to their upstream MCP server.
  getIssue?(key: string): Promise<TrackerIssue>
  commentIssue?(args: TrackerCommentArgs): Promise<void>
  transitionIssue?(args: TrackerTransitionArgs): Promise<void>

  /**
   * Plugin-driven webhook normalisation; same shape as SCM's.
   */
  normalizeInbound?(req: {
    headers: Record<string, string | string[] | undefined>
    rawBody: Buffer
  }): NormalizedEvent | null
}

// ── Drop-in manifest (`coro-plugin.json`) ───────────────────────────────────

/**
 * On-disk manifest authored by drop-in plugin packages and read by the
 * runner's loader (`packages/runner/src/plugins/loader.ts`). The shape
 * is stable across SDK versions; new fields land additively.
 */
export interface DropinManifest {
  /** Must equal `manifest.id` of the runtime exported from `entry`. */
  id: string
  kind: PluginKind
  /** Plugin's own semver. */
  version: string
  displayName: string
  /** Semver range against the host's plugin-API version. */
  hostCompatibility: string
  /** Relative path (from the manifest dir) to a CJS/ESM module exporting `createPlugin`. */
  entry: string
}

// ── Phase executor plugin ───────────────────────────────────────────────────
//
// `executor` is the third plugin kind alongside `scm` and `tracker`. An
// executor is the per-phase LLM driver: each provider (Anthropic via the
// Claude Agent SDK, OpenAI via the Responses API, Foundry/OpenRouter
// aggregators, local Ollama, …) ships its own executor plugin and owns
// the full per-phase invocation — tool loop, hooks, subagents, session
// resume, cost accounting.
//
// The runner core stays provider-agnostic. It resolves an executor for
// each phase, builds a {@link PhaseExecutionRequest}, and consumes the
// returned {@link PhaseExecutorEvent} stream. See `runner/jobs/runner.ts`
// for the call site.
//
// Why an `executePhase` seam (rather than a thinner token streamer):
// the Claude Agent SDK already runs the tool loop, hooks, and subagents
// internally, and stateless providers (OpenAI, Ollama) need different
// tool-call shapes and session strategies. Wrapping at any thinner level
// fights every provider's design.

/**
 * Normalized token / cost accounting reported by an executor for one
 * phase. Providers may also report `totalCostUsd` directly (Anthropic
 * does); for providers that don't, the runner uses the executor's
 * {@link PhaseExecutorRuntime.calculateCost} hook to derive cost from
 * tokens against a bundled pricing table.
 */
export interface NormalizedTokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  /** Optional — provider may report it directly (Anthropic does). */
  totalCostUsd?: number
}

/**
 * Dual-shape session state. An executor populates the field that matches
 * its resume strategy:
 *
 *   - Claude SDK executors persist `sessionId` and ignore `conversationHistory`.
 *   - Stateless executors (OpenAI Responses, Ollama) persist `conversationHistory`
 *     and ignore `sessionId`.
 *
 * Both fields coexist on the persisted Job so a workflow that mixes
 * providers across phases (e.g. planning on Claude, coding on GPT) can
 * still resume each phase against the executor that wrote the state.
 */
export interface ExecutorSessionState {
  sessionId?: string
  conversationHistory?: ReadonlyArray<ConversationMessage>
}

/**
 * One model entry returned by {@link PhaseExecutorRuntime.listModels}.
 * Aggregator plugins (OpenRouter, Foundry) return many; single-provider
 * plugins typically return a small fixed list. The runner uses this to
 * power the dashboard's per-provider model picker and to validate
 * `provider`+`model` pairs in workflow YAML.
 */
export interface ExecutorModelDescriptor {
  id: string
  displayName: string
  contextTokens: number
  /** Suggested role — runner uses this for default alias seeding only. */
  tier?: 'planning' | 'coding' | 'mini'
  /** True when the model supports `modelHints.reasoningEffort`. */
  supportsThinking?: boolean
  /** Static pricing snapshot in USD per 1M tokens; aggregators may omit. */
  pricing?: {
    inputPerMTokens?: number
    outputPerMTokens?: number
    cacheReadPerMTokens?: number
    cacheCreationPerMTokens?: number
  }
}

/**
 * Capability flags an executor MUST publish at registration time. The
 * runner uses these to decide whether to:
 *   - inject `.claude/CLAUDE.md` into the system prompt manually
 *     (false → runner prepends; true → executor's SDK does its own walk-up).
 *   - register the file-tools MCP server for this phase
 *     (false → runner registers `file_read`/`file_write`/etc.; true →
 *     executor brings native equivalents).
 *   - allow `req.subagents` to be non-empty
 *     (false → runner falls back to the `run_subagent` MCP tool, see Phase 9).
 *   - persist `sessionId` vs `conversationHistory` after each phase.
 */
export interface ExecutorCapabilities {
  /** True when the executor runs subagents itself (Anthropic SDK). */
  supportsNativeSubagents: boolean
  /** True when the executor's SDK loads `.claude/CLAUDE.md` via its own walk-up. */
  supportsClaudeMdNativeWalkUp: boolean
  /** True when the executor brings native Read/Write/Edit/Glob/Grep tools. */
  supportsNativeFileTools: boolean
  /** True when resume by sessionId is supported (Claude SDK). */
  supportsSessionResume: boolean
  /** True when resume by conversation replay is supported (most others). */
  supportsConversationReplay: boolean
  /** True when `modelHints.reasoningEffort` has any effect. */
  supportsThinking: boolean
  /** True when image content blocks may be passed in user messages. */
  supportsImageInput: boolean
  /** Hard ceiling — runner refuses oversized prompts. */
  maxContextTokens: number
}

/**
 * Hook policy the runner hands to every executor. The executor enforces
 * the policy at every tool-call site (typically via the SDK helpers in
 * `executor-helpers.ts`).
 *
 * `writeRoots` are absolute paths; the runner resolves the workflow's
 * working dir, repo clone dir, and `_intelligence/` mirror up front so
 * each executor only does string-prefix membership checks.
 */
export interface HookPolicy {
  /** null → no whitelist; every tool the SDK exposes is allowed. */
  allowedTools: ReadonlyArray<string> | null
  /** Absolute paths the agent may write to. */
  writeRoots: ReadonlyArray<string>
  /** Optional extra gate the runner injects (e.g. for proposal review). */
  onPreToolUse?(
    toolName: string,
    input: unknown,
  ): { allow: boolean; reason?: string } | Promise<{ allow: boolean; reason?: string }>
}

/**
 * Subagent specification handed to an executor. The runner builds these
 * from workflow YAML's `subagents:` block. Each entry corresponds to one
 * agent file (`agents/<name>.md`) plus runtime knobs.
 *
 * Anthropic-flavoured executors map this onto the SDK's `agents:` field;
 * non-native executors invoke them via the runner's `run_subagent` MCP
 * tool (Phase 9).
 */
export interface ExecutorSubagentSpec {
  /** Subagent identifier (matches the `agents:` key in workflow YAML). */
  name: string
  /** Already-loaded agent prompt (`.claude/CLAUDE.md` is prepended for you). */
  systemPrompt: string
  /** Optional per-subagent model override (literal — not an alias). */
  model?: string
  /** Optional per-subagent provider override; required when crossing executors. */
  provider?: string
  /** Tool whitelist for this subagent (subset of the parent phase's). */
  allowedTools?: ReadonlyArray<string>
  /** MCP servers the subagent may invoke (subset of the parent's set). */
  mcpServerIds?: ReadonlyArray<string>
}

/**
 * Stable descriptor for the in-process Coro MCP server that every
 * executor receives. The runner constructs the underlying SDK MCP
 * server once per job and hands the executor the descriptor it needs to
 * register the tools (under the reserved `coro` server id) with the
 * provider's tool loop.
 *
 * The shape is intentionally narrow so that future MCP transports
 * (`http`, `sse`) can be added without breaking plugin authors. Today
 * only `kind: 'sdk-instance'` exists; it carries the live SDK MCP
 * server reference under `instance: unknown` (the runner re-types it at
 * the call site against the Anthropic SDK's `McpSdkServerConfig`).
 */
export interface McpServerDescriptor {
  kind: 'sdk-instance'
  /** Reserved id under which the runner expects the executor to register the server. */
  id: 'coro'
  /** Opaque SDK instance — runtime cast at the executor boundary. */
  instance: unknown
}

/**
 * Single per-phase invocation request. The runner builds this from the
 * resolved workflow phase config + intelligence layer + plugin registry.
 *
 * All paths are absolute. All timestamps are runtime concerns the
 * executor never needs to know about.
 */
export interface PhaseExecutionRequest {
  /** Already-built system prompt; do not append your own header. */
  systemPrompt: string
  /** User prompt for this phase. May be a fresh task or a resume payload. */
  userPrompt: string
  /** Literal model id (alias resolution happens upstream in the runner). */
  model: string
  /** Optional per-invocation knobs (reasoning effort, etc.). */
  modelHints?: { reasoningEffort?: 'low' | 'medium' | 'high' }
  /** Working dir the agent's tools may operate within (absolute). */
  cwd: string
  /** Materialized intelligence layer for this job (absolute). */
  intelligenceDir: string
  /** In-process Coro MCP server descriptor; always provided. */
  mcpServer: McpServerDescriptor
  /** External plugin MCP servers (SCM, tracker, …) keyed by plugin id. */
  pluginMcpServers: Record<string, PluginMcpServerConfig>
  /** Optional subagent specs the executor may dispatch. */
  subagents?: ReadonlyArray<ExecutorSubagentSpec>
  /** Hook policy — write-root guard + tool whitelist; executor enforces. */
  hookPolicy: HookPolicy
  /** Prior session state to resume from. Empty on the first phase of a job. */
  sessionState: ExecutorSessionState
  /** Hard ceiling on tool-loop turns this phase. */
  maxTurns: number
  /** Optional log-context label — the runner labels with the workflow phase name. */
  phase?: string
  /** Cancellation signal — runner aborts on job cancel / shutdown. */
  signal: AbortSignal
  /**
   * Optional lifecycle hooks. The dispatcher uses these to register the
   * in-flight session for cancellation/preemption. Executors that don't
   * support mid-turn preemption may treat them as no-ops.
   */
  lifecycle?: ExecutorLifecycleHooks
  /**
   * Optional live developer-input channel. The dispatcher pushes
   * additional user messages mid-phase (e.g. clarifications, follow-up
   * instructions). Streaming-input executors (Anthropic Claude SDK) push
   * straight into the live tool loop; non-streaming executors may buffer
   * and replay on the next turn.
   */
  developerInput?: DeveloperInputChannel
}

/**
 * Per-phase metrics surfaced on the terminal `done` event. All fields
 * are optional because non-Anthropic providers may not report them.
 */
export interface PhaseExecutorMetrics {
  durationMs?: number
  durationApiMs?: number
  numTurns?: number
}

/**
 * Live session controller exposed by the executor at session-start time.
 * The dispatcher uses {@link ExecutorSessionController.interrupt} to
 * cancel an in-flight tool loop (e.g. on developer escalation).
 */
export interface ExecutorSessionController {
  interrupt(): Promise<void>
}

/**
 * Channel the executor receives so the dispatcher can stream additional
 * developer messages into the in-flight session. Non-streaming executors
 * may treat `push` as a buffer and consume on the next turn.
 */
export interface DeveloperInputChannel {
  push(message: ConversationMessage): void
  close(): void
}

/**
 * Executor → runner lifecycle callbacks. The runner registers handles
 * the dispatcher needs for cancellation/preemption; the executor invokes
 * them at well-defined points in the per-phase lifecycle.
 */
export interface ExecutorLifecycleHooks {
  /**
   * Called once after the executor has set up its native session but
   * before the model produces any output. The runner records the
   * controller so the dispatcher can interrupt mid-turn.
   */
  onSessionStart?(controller: ExecutorSessionController): void
  /**
   * Called exactly once when the executor's per-phase invocation has
   * fully terminated (success, error, or abort). The runner uses this
   * to drop the controller reference and any developer-input buffer.
   */
  onSessionEnd?(): void
}

/**
 * Normalized event the executor yields during {@link PhaseExecutorRuntime.executePhase}.
 * The runner translates these into log lines, token accounting, and
 * dashboard updates without ever inspecting provider-native shapes.
 *
 * Executors MUST emit `done` exactly once at the end of a successful
 * stream and MUST emit at least one `usage` event before `done`. The
 * runner treats absence of `usage` as `tokens=0, cost=0` rather than
 * an error, but it is the executor's responsibility to report what it
 * knows.
 */
export type PhaseExecutorEvent =
  | { type: 'session_start'; sessionId?: string }
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | {
      type: 'tool_call'
      toolName: string
      input: unknown
      /** True when the tool came from an MCP server (vs. a built-in like Bash). */
      isMcp: boolean
    }
  | {
      type: 'tool_result'
      toolName: string
      output: unknown
      isError?: boolean
    }
  | {
      type: 'usage'
      tokens: NormalizedTokenUsage
      /** Per-model breakdown when the executor multiplexes (aggregators). */
      modelUsage?: Record<string, NormalizedTokenUsage>
    }
  | {
      type: 'done'
      stopReason: string
      sessionState: ExecutorSessionState
      /** Optional per-phase metrics (duration, turn count). */
      metrics?: PhaseExecutorMetrics
    }
  | {
      type: 'log'
      level: 'info' | 'warn' | 'error'
      message: string
      meta?: Record<string, unknown>
    }

/**
 * Phase executor runtime contract. Implementations live in their own
 * package (`@coro/llm-anthropic`, `@coro/llm-openai`, …) and register
 * themselves under `kind: 'executor'` via the standard plugin loader.
 *
 * Every executor MUST:
 *   1. Publish capabilities at construction time so the runner can
 *      decide whether to inject `.claude/CLAUDE.md` and register
 *      file-tools MCP shims.
 *   2. Honor {@link PhaseExecutionRequest.signal} — abort the in-flight
 *      tool loop within ~1s of cancellation.
 *   3. Enforce {@link HookPolicy} at every tool-call site (use the
 *      helpers from `executor-helpers.ts` to avoid drift).
 *   4. Yield exactly one `done` event with the next session state.
 */
export interface PhaseExecutorRuntime<Config = unknown> extends PluginRuntime<Config> {
  readonly kind: 'executor'
  readonly capabilities: ExecutorCapabilities

  /** What models this executor can run. Aggregators return many. */
  listModels(): ReadonlyArray<ExecutorModelDescriptor>

  /** Cheap predicate the registry uses for model → executor routing. */
  supports(model: string): boolean

  /** The single per-phase entry point. */
  executePhase(req: PhaseExecutionRequest): AsyncIterable<PhaseExecutorEvent>

  /**
   * Optional per-provider cost calculation. Plugins that trust an
   * upstream `total_cost_usd` (Anthropic) leave this undefined; the
   * runner reads `usage.tokens.totalCostUsd` directly. Plugins that
   * own their pricing tables (OpenAI, Foundry, Ollama=$0) implement it.
   */
  calculateCost?(model: string, usage: NormalizedTokenUsage): number

  /**
   * Optional default alias seed. The runner consults this once at
   * bootstrap when `settings.llm.aliases` is empty so workflows can
   * reference `model: 'planning'` / `model: 'coding'` without
   * tenant-side config. Anthropic returns
   * `{ planning: { provider: 'anthropic', model: 'claude-opus-4-6' },
   *   coding:   { provider: 'anthropic', model: 'claude-sonnet-4-6' } }`.
   * Future providers ship their own tier-appropriate defaults.
   *
   * The runner never writes these defaults back to disk — they only
   * influence in-memory `Settings.llm.aliases` resolution.
   */
  defaultAliases?(): Record<string, { provider: string; model: string }>

  /**
   * Run a single side-conversation to completion and return the final
   * assistant text. The runner exposes this through the
   * `mcp__coro__run_subagent` MCP tool — but ONLY for parent phases
   * whose executor reports `supportsNativeSubagents: false`.
   * Anthropic's SDK already exposes a native Task tool, so the
   * Anthropic executor leaves this undefined and the runner suppresses
   * the MCP tool to avoid two parallel dispatch paths.
   *
   * Implementations should treat the subagent as a fresh,
   * stateless conversation — no session persistence, no resume,
   * no nested subagents. Tool calls are still allowed (the agent
   * may use Read / Grep / propose_change / etc.) but the loop is
   * bounded by `maxTurns` and terminates as soon as the model
   * emits an assistant message with no tool calls.
   */
  runSubagent?(req: SubagentExecutionRequest): Promise<SubagentResult>
}

/**
 * Per-call request for {@link PhaseExecutorRuntime.runSubagent}. A
 * narrow subset of {@link PhaseExecutionRequest} — no session, no
 * developer-input channel, no recursion. The runner builds this from
 * the workflow's `subagents:` declaration plus the parent phase's
 * resolved tool / MCP-server context.
 */
export interface SubagentExecutionRequest {
  /** Subagent identifier from the workflow YAML (for logs only). */
  name: string
  /** Already-built system prompt — runner has loaded the agent file. */
  systemPrompt: string
  /** The task the parent agent wants this subagent to perform. */
  task: string
  /** Literal model id (alias resolution happens upstream). */
  model: string
  /** Optional per-invocation knobs. */
  modelHints?: { reasoningEffort?: 'low' | 'medium' | 'high' }
  /** Working dir for any tool calls (typically same as parent). */
  cwd: string
  /** Materialized intelligence layer for this job. */
  intelligenceDir: string
  /** In-process Coro MCP server descriptor; always provided. */
  mcpServer: McpServerDescriptor
  /** External plugin MCP servers (SCM, tracker, …) keyed by plugin id. */
  pluginMcpServers: Record<string, PluginMcpServerConfig>
  /** Tool whitelist for this subagent (typically read-only + Coro tools). */
  allowedTools: ReadonlyArray<string>
  /** Hook policy — write-root guard etc.; executor enforces. */
  hookPolicy: HookPolicy
  /** Hard ceiling on tool-loop turns. Recommend 16. */
  maxTurns: number
  /** Cancellation signal — runner aborts on parent cancel/shutdown. */
  signal: AbortSignal
}

/**
 * Terminal result from a subagent invocation. The MCP tool returns this
 * verbatim (minus internal fields) to the parent agent.
 */
export interface SubagentResult {
  /** Final assistant text content. */
  output: string
  /** Token usage + cost across the entire subagent loop. */
  usage: NormalizedTokenUsage
  /** Stop reason mirrored from the executor (`end_turn`, `max_turns`, …). */
  stopReason: string
}
