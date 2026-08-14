// ── Plugin SDK types ─────────────────────────────────────────────────────────
//
// Public, authoring-side mirror of the runner's `plugins/types.ts`. We
// deliberately *duplicate* (rather than re-export from `@coro-ai/runner`)
// so:
//
//   1. Drop-in plugin authors can install `@coro-ai/plugin-sdk` without
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
// `plugins/refs.ts`. They now live in `@coro-ai/cloud-protocol` — the
// shared wire-contract package depended on by runner, cloud, and SDK
// alike — so there is exactly one canonical definition. Plugin
// authors import them directly from `@coro-ai/cloud-protocol`.

import type { Logger } from 'pino'
import type { ZodTypeAny } from 'zod'
import type { ConversationMessage, ExternalRef, NormalizedEvent } from '@coro-ai/cloud-protocol'

// Re-export `ConversationMessage` so plugin authors authoring an
// executor can import it from `@coro-ai/plugin-sdk` alongside the rest of
// the executor contract (`ExecutorSessionState`, `PhaseExecutorRuntime`,
// etc.). The canonical definition lives in `@coro-ai/cloud-protocol`
// because it's part of the persisted `Job.conversationHistory` wire shape.
export type { ConversationMessage } from '@coro-ai/cloud-protocol'

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

// ── Auth method descriptors (onboarding) ────────────────────────────────────

export type PluginAuthFieldKind = 'text' | 'secret' | 'url'

export interface PluginAuthFieldDescriptor {
  /** Plugin-config key (matches configSchema). */
  key: string
  label: string
  hint?: string
  placeholder?: string
  kind: PluginAuthFieldKind
  required?: boolean
}

export type PluginAuthMethodDescriptor =
  | {
      kind: 'oauth'
      id: string
      label: string
      recommended?: boolean
      /** POST — plugin registers via registerHttpRoutes. */
      startPath: string
      /** GET — polled by the dashboard. */
      statusPath: string
      /** Merged into plugin config when the user selects this method. */
      configOnSelect?: Record<string, unknown>
      /** Dot-path (e.g. `account.email`) populated from OAuth success account label. */
      successAccountPath?: string
      /** When set, dashboard shows a BYO OAuth client ID field bound to this config key. */
      clientIdConfigKey?: string
    }
  | {
      kind: 'detect'
      id: string
      label: string
      recommended?: boolean
      /** Config key the user can override before apply (e.g. org owner). */
      accountConfigKey?: string
    }
  | {
      kind: 'form'
      id: string
      label: string
      recommended?: boolean
      fields: PluginAuthFieldDescriptor[]
      /** Merged into plugin config when the user selects this method. */
      configOnSelect?: Record<string, unknown>
    }

export interface PluginAuthDescriptor {
  methods: ReadonlyArray<PluginAuthMethodDescriptor>
}

/**
 * Response shape every `oauth` method's `statusPath` must return. The
 * dashboard renders from these fields alone — it must never need to know
 * which provider it is talking to.
 */
export interface PluginOAuthStatus {
  state: 'idle' | 'pending' | 'success' | 'error'
  /** Present while pending: where to send the user. */
  authorizeUrl?: string
  /** Present while pending, for device-style flows. */
  userCode?: string
  /** Present on success. */
  account?: { label: string }
  /** Human-readable detail for `error`, or context for `idle`. */
  message?: string
  /**
   * Machine-readable reason, so the dashboard never has to pattern-match
   * on `message`. `setup_required` means the flow cannot start until the
   * user does something outside Coro (install a CLI, register an OAuth
   * app) — the dashboard renders that as guidance rather than a failure.
   */
  code?: 'setup_required'
  /** False when this flow cannot run on this machine as configured. */
  available?: boolean
  /** What the user must do when `code === 'setup_required'`. */
  setupHint?: string
  /** Redirect URI to register, for flows that need one. */
  callbackUrl?: string
}

/**
 * One locally-detectable credential bundle. Raw `config` is server-side
 * only — the dashboard sees {@link preview} and applies by {@link id}.
 */
export interface CredentialCandidate {
  id: string
  sourceLabel: string
  accountHint?: string
  config: Record<string, unknown>
  preview: ReadonlyArray<{ label: string; value: string }>
}

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
  /** Declarative auth methods for the FTUE wizard and Settings. */
  auth?: PluginAuthDescriptor
  ui?: {
    customPanel?: string
    /** One-line subtitle for onboarding provider cards. */
    subtitle?: string
    /** When true, the FTUE wizard renders a "Recommended" pill. */
    recommendedForOnboarding?: boolean
    /**
     * How this provider names a repository. Drives the Create Job
     * repository field's label, hint, placeholder, and validation, so the
     * dashboard can ask for the right thing without knowing which provider
     * is active. Defaults to `slug` (`owner/repo`) when omitted.
     */
    repoRef?: PluginRepoRefDescriptor
  }
}

export interface PluginRepoRefDescriptor {
  /** `slug` is `owner/repo`; `path` is an absolute filesystem path. */
  kind: 'slug' | 'path'
  label?: string
  hint?: string
  placeholder?: string
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
 * One step in a multi-step credential probe — surfaced as a bullet
 * under the test button. Plugins that touch multiple resources (e.g.
 * SCM auth + workspace access + clone scope) use this to tell the
 * user exactly which leg failed.
 */
export interface PluginTestCheck {
  name: string
  ok: boolean
  message: string
  /** Optional remediation tip shown under failed checks. */
  hint?: string
}

/**
 * Result of {@link PluginRuntime.testConnection}. Mirrors the
 * dashboard's `TestConnectionResult` so the runner is a thin pass-through.
 *
 * Distinct from {@link PluginHealth} because `testConnection` actively
 * contacts the upstream (and may cost a tiny amount of tokens / a real
 * round-trip) whereas `healthcheck()` is a fast in-process shape check.
 * The dashboard's "Test connection" button is the only caller of
 * `testConnection`; periodic health surfaces use `healthcheck()`.
 */
export interface PluginTestResult {
  ok: boolean
  message?: string
  /** Optional remediation tip — shown next to the status line. */
  hint?: string
  /** Optional per-step breakdown. */
  checks?: ReadonlyArray<PluginTestCheck>
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
  /**
   * Optional active credential probe. The runner invokes this from the
   * dashboard's "Test connection" button (`POST /test/plugin/:id`).
   * Plugins receive the *merged* config the user is about to save —
   * masked secrets (`ghp_abcdefghijkl...wxyz`) already replaced with the
   * real values from the on-disk config — and reach out to their upstream
   * to verify the credentials actually work.
   *
   * This is the seam that keeps the runner core provider-agnostic.
   * Without it, every new LLM/SCM/tracker plugin needs a `case`
   * branch in `server.ts`. Plugins that don't implement it fall
   * back to {@link PluginRuntime.healthcheck} — which is the right
   * default for "config-only" plugins whose only check is "is the
   * field non-empty".
   *
   * Implementations MUST NOT throw — return `{ ok: false, message }`
   * for any failure so the dashboard always gets a structured result.
   */
  testConnection?(config: Config): Promise<PluginTestResult>
  /**
   * Optional local credential discovery. The runner caches raw results
   * server-side; the dashboard applies a candidate by id.
   */
  detectCredentials?(): Promise<ReadonlyArray<CredentialCandidate>>
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
  /**
   * Account owning the branch, when it lives in a fork rather than in
   * `repoSlug`. Set for open-source contributions, where the job can push
   * to its fork but not to the repository it is targeting.
   *
   * Providers without a fork-PR concept should ignore it; a provider that
   * silently opened the PR inside the fork instead would produce a PR
   * nobody upstream ever sees.
   */
  sourceOwner?: string
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

export interface ScmReadFileResult {
  content: string
  encoding: 'utf-8' | 'base64'
  truncated?: boolean
}

export interface ScmCodeSearchHit {
  path: string
  /**
   * Match snippets returned by the SCM provider. `seq` is a stable
   * ordering within the hit's snippet array; it is NOT the file line
   * number — provider search APIs (GitHub, Bitbucket) return fragments
   * without absolute line offsets, so we never claim one.
   *
   * When the underlying provider matched on the file path only
   * (Bitbucket's `path_matches` with no `content_matches`), the
   * snippets array is empty and `pathMatchOnly` is true. The plan-mode
   * agent uses this to distinguish "filename hit, content unknown"
   * from "we got nothing".
   */
  snippets: ReadonlyArray<{ seq: number; content: string }>
  pathMatchOnly?: boolean
}

/**
 * One entry returned by `ScmPluginRuntime.listFiles`. We keep the
 * shape minimal so it works for both Bitbucket (`/src/{ref}/{path}`)
 * and GitHub (`/repos/{owner}/{repo}/contents/{path}`) without
 * leaking provider-specific fields.
 */
export interface ScmDirectoryEntry {
  /** Path relative to the repository root, e.g. "src/foo/Bar.cs". */
  path: string
  /** Entry kind. `file` = readable via `readFile`, `dir` = traversable. */
  type: 'file' | 'dir'
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

  /** Read a single file via the SCM provider REST API (plan mode, agents). */
  readFile?(args: { repo: string; path: string; ref?: string }): Promise<ScmReadFileResult>
  /** Search code in a repository via the SCM provider REST API. */
  searchCode?(args: { repo: string; query: string; maxResults?: number }): Promise<ReadonlyArray<ScmCodeSearchHit>>
  /**
   * List entries in a repository directory. Used by plan mode to
   * discover the repo structure without a working clone — without it
   * the agent has to guess paths and gets 404s on the first try.
   *
   * `path` defaults to the repository root when omitted/empty. `ref`
   * defaults to the repo's default branch.
   */
  listFiles?(args: { repo: string; path?: string; ref?: string }): Promise<ReadonlyArray<ScmDirectoryEntry>>

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

export interface TrackerComment {
  /** Provider-native comment id (stable handle for threading / dedup). */
  id: string
  /** Comment body as plain text / markdown. */
  body: string
  /** Display name or handle of the author, when the provider exposes one. */
  author?: string
  /** ISO-8601 creation timestamp. */
  createdAt: string
  /** ISO-8601 last-edit timestamp, when distinct from createdAt. */
  updatedAt?: string
  /** Deep link to the comment, when the provider exposes one. */
  url?: string
  /**
   * Id of the comment this one replies to, when the provider exposes a
   * threaded/nested comment model (Jira Software/Business, Linear).
   * Absent on top-level comments and on providers with a flat comment
   * model (GitHub Issues).
   */
  parentId?: string
}

export interface TrackerCommentArgs {
  key: string
  body: string
  /**
   * When set, post this comment as a threaded reply to the comment with
   * this id. Providers that support native threading (Jira, Linear)
   * nest the reply; flat providers (GitHub Issues) ignore it and post a
   * top-level comment.
   */
  parentId?: string
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
  searchIssues?(query: string, limit?: number): Promise<ReadonlyArray<TrackerIssue>>
  /**
   * Read the comment thread on an issue. Comments are intentionally NOT
   * folded into {@link TrackerIssue} so reading them is an explicit,
   * opt-in call (they can be large and most phases don't need them).
   * MCP-mode plugins may omit this and map `tracker_get_comments` to an
   * upstream tool via `manifest.mcpToolMap`.
   */
  getComments?(key: string): Promise<ReadonlyArray<TrackerComment>>
  commentIssue?(args: TrackerCommentArgs): Promise<void>
  transitionIssue?(args: TrackerTransitionArgs): Promise<void>

  /**
   * Provider-specific defaults the runner injects into the agent's
   * job-context block as `tracker.defaults`. Agents read these to
   * fill in arguments the user expects to be pre-known for the
   * tenant — e.g. GitHub Issues' `owner`, Linear's `teamKey`.
   *
   * Keys are provider-specific by design so the agent prompt can
   * reference them unambiguously (no per-provider branches in code).
   * Return `undefined` (or omit the method) when there are no
   * defaults to expose.
   */
  promptDefaults?(): Record<string, string> | undefined

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
  /**
   * Marks this model as the canonical default for its {@link tier}. The
   * tier-default helpers (`tierDefaultAliases`, `defaultModelForTier`)
   * prefer a flagged model over catalogue order, so a catalogue can list
   * a newer/experimental model ahead of the current default without
   * silently promoting it. Exactly one model per tier should set this;
   * if none do, the first model of the tier wins.
   */
  isDefault?: boolean
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
  /** Optional per-invocation knobs (e.g. reasoning effort) resolved from the alias. */
  modelHints?: { reasoningEffort?: 'low' | 'medium' | 'high' }
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
  /**
   * Optional rebuild hook for the in-process Coro MCP server. The Anthropic
   * executor calls this after an urgent steering interrupt so `setMcpServers`
   * registers a fresh SDK instance (reconnect is a no-op for SDK servers).
   */
  mcpRebuild?: () => McpServerDescriptor
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
 * A shell sandbox imposed by the host — machine policy, MDM, or an
 * organisation policy fetched by the provider CLI — that the executor
 * has asked to disable but cannot actually override.
 *
 * This is deliberately separate from {@link HookPolicy}, which is Coro's
 * *own* confinement and always applies. A `HookPolicy` denial rejects the
 * tool call before it runs; a host sandbox lets the command run and then
 * fails it at the syscall or socket, which reads very differently to the
 * agent and needs a different recovery.
 */
export interface ExecutorSandboxReport {
  /** Absolute paths of the settings sources that pin the sandbox on. */
  sources: ReadonlyArray<string>
  /**
   * Writes outside the working directory are expected to fail. Reads are
   * usually still permitted, which is what makes warm caches salvageable.
   */
  restrictsWritesOutsideWorkingDir: boolean
  /** Outbound hosts the policy permits, when it defines an allowlist. */
  allowedDomains?: ReadonlyArray<string>
  /** Commands the policy exempts from the sandbox entirely (e.g. `git`). */
  excludedCommands?: ReadonlyArray<string>
  /** Paths outside the working directory the policy still allows writing. */
  allowWritePaths?: ReadonlyArray<string>
  /**
   * True when the per-command "run this unsandboxed" escape hatch is off.
   * Matters because that hatch surfaces as an interactive prompt no
   * headless agent can answer — retrying is guaranteed to fail.
   */
  blocksUnsandboxedCommands?: boolean
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
 * How aggressively to preempt the current agent turn when steering.
 *
 * - `safe` — queue the message; skip `interrupt()` while an MCP tool is
 *   in flight so the transport is not torn down mid-request.
 * - `urgent` — always `interrupt()` and synchronously heal MCP before
 *   returning (used for pause and when no MCP tool is active).
 */
export type SteeringInterruptMode = 'safe' | 'urgent'

/**
 * Live session controller exposed by the executor at session-start time.
 * The dispatcher uses {@link ExecutorSessionController.interrupt} to
 * cancel an in-flight tool loop (e.g. on developer escalation).
 */
export interface ExecutorSessionController {
  interrupt(options?: { mode?: SteeringInterruptMode }): Promise<void>
  /**
   * Hard-stop the current phase. Unlike {@link interrupt} — which only
   * makes the agent *yield* its turn so a steering message can be read,
   * keeping the phase alive — `stop` ends the phase outright: it aborts
   * the phase signal so the executor breaks out of its event loop and
   * `executePhase` returns. The runner then reaches its post-phase
   * boundary check and parks cleanly. Used by developer-initiated pause,
   * where the intent is for the agent to actually stop, not continue.
   *
   * Optional so executors that cannot abort mid-phase still satisfy the
   * interface; the dispatcher falls back to {@link interrupt} when a
   * controller does not implement it.
   */
  stop?(): Promise<void>
  /**
   * Optional steering snapshot. Anthropic executor reports in-flight MCP
   * tools so the dispatcher can choose safe vs urgent interrupt.
   */
  getSteeringState?(): { inFlightMcpTool: string | null }
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
 * package (`@coro-ai/llm-anthropic`, `@coro-ai/llm-openai`, …) and register
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

  /**
   * Report a host-enforced sandbox the executor knows about but cannot
   * switch off. Optional — executors that never run shell commands in a
   * confined environment, or that have no way to inspect one, return
   * `null` or omit the method entirely.
   *
   * The runner folds a non-null report into the system prompt so the
   * agent learns the real constraints up front instead of rediscovering
   * them through an opaque `EPERM` mid-build. Called once per phase;
   * implementations should be cheap and must not throw.
   */
  describeSandbox?(): ExecutorSandboxReport | null

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
   * tenant-side config.
   *
   * The recommended implementation derives these from `listModels()`
   * via {@link tierDefaultAliases} so the model catalogue stays the
   * single source of truth — the tier defaults fall out of each
   * descriptor's `tier` + `isDefault` tags. Anthropic returns
   * `{ 'tier:planning': { provider: 'anthropic', model: 'claude-opus-4-8' },
   *    'tier:coding':   { provider: 'anthropic', model: 'claude-sonnet-5' }, … }`.
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

  /**
   * Optional simple chat completion path. Bypasses workflow tools, MCP
   * bridges, hooks, working dirs, and subagent orchestration — intended
   * for surfaces that just need a conversational response (e.g. Coro
   * plan mode intake). Implementations should call the provider's HTTP
   * API directly, without spawning subprocess agents.
   */
  chat?(req: ChatRequest): Promise<ChatResult>
}

/** Provider-agnostic tool definition for {@link PhaseExecutorRuntime.chat}. */
export interface ChatTool {
  name: string
  description: string
  /** JSON Schema object describing the tool input. */
  inputSchema: object
}

/** One executed tool call recorded by {@link PhaseExecutorRuntime.chat}. */
export interface ChatToolCallRecord {
  name: string
  input: unknown
  output: unknown
  durationMs: number
  error?: string
}

/**
 * Per-call request for {@link PhaseExecutorRuntime.chat}. Stateless by
 * default; optional tools + `runTool` enable a bounded tool-use loop.
 */
export interface ChatRequest {
  /** Conversation messages (alternating user/assistant). */
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>
  /** Optional system instructions. */
  systemPrompt?: string
  /** Concrete model id. */
  model: string
  /** Optional max output tokens. Provider default applies when omitted. */
  maxOutputTokens?: number
  /** Cancellation signal. */
  signal: AbortSignal
  /** Optional read-only tools the model may invoke during this turn. */
  tools?: ReadonlyArray<ChatTool>
  /** Runner-supplied dispatcher; required when `tools` is non-empty. */
  runTool?: (name: string, input: unknown) => Promise<unknown>
  /** Hard ceiling on tool round-trips (default 5). */
  maxToolRounds?: number
  /** Fired immediately before each tool invocation (for live UI / SSE). */
  onToolStart?: (info: { name: string; input: unknown }) => void
  /** Fired after each tool invocation completes. */
  onToolEnd?: (record: ChatToolCallRecord) => void
  /**
   * BYO MCP servers enabled for plan mode (`planMode: true` in config).
   * Attached alongside built-in intake tools; agents call them as
   * `mcp__<id>__*`.
   */
  pluginMcpServers?: Record<string, PluginMcpServerConfig>
}

/** Terminal result from a single {@link PhaseExecutorRuntime.chat} call. */
export interface ChatResult {
  /** Concatenated assistant text. */
  output: string
  /** Normalized token usage; cost is owned by the runner's accounting. */
  usage: NormalizedTokenUsage
  /** Tool calls executed during this chat turn (empty when no tools). */
  toolCalls: ReadonlyArray<ChatToolCallRecord>
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
