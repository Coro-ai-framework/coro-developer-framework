// ── Plugin contracts ─────────────────────────────────────────────────────────
//
// Every Coro provider integration (BitBucket, GitHub, Jira, Linear, …) is a
// plugin behind one of two contracts:
//
//   - SourceControl (`kind: 'scm'`)   — repos, PRs, comments, merges.
//   - IssueTracker (`kind: 'tracker'`) — tickets, transitions, links.
//
// A plugin has two halves so the cloud control plane can know *about* a
// plugin (config schema, webhook descriptor) without ever importing or
// running the runtime code:
//
//   1. Manifest — static, JSON-serialisable. Sent to the cloud at
//      tenant configuration time. Drives webhook HMAC verification, UI
//      forms (configSchema), and the cloud's `tenant_plugin_webhooks`
//      lookup.
//   2. Runtime — TypeScript only, runner-only. Concrete client, MCP
//      tool registrations, webhook normalizer, healthcheck.
//
// The runner loads runtimes lazily through {@link PluginRegistry}; the
// cloud loads only manifests from a separate manifest registry (see
// `cloud/db` and a future `manifest-registry.ts`). The two are kept
// purposely disjoint to enforce that the cloud cannot accidentally
// depend on runtime code.

import type { Logger } from 'pino'
import type { ZodTypeAny } from 'zod'
import type { ExternalRef, NormalizedEvent } from '@coro-ai/cloud-protocol'

// ── External MCP server descriptor ──────────────────────────────────────────
//
// A plugin can expose an *external* MCP server that the runner attaches to
// every job's session. This is the MCP-first pivot's outbound channel —
// the model talks to the provider via `mcp__<pluginId>__<toolName>` tools
// served by the upstream MCP server (e.g. `@modelcontextprotocol/server-github`).
//
// This is intentionally narrower than the SDK's full union: we only allow
// the *serialisable* transport variants (stdio / http / sse). The in-process
// SDK MCP server (`type: 'sdk'`) is reserved for Coro's own MCP server —
// plugins can't mount in-process servers, since they'd share the runner's
// memory space and bypass the plugin sandbox.
//
// Plugins that need fine-grained tool exposure can carry a `disallowedTools`
// or `allowedTools` array in their manifest's `capabilities` block; the
// runner reads that out and applies it to the SDK's per-server tool policy
// when attaching.

/** stdio-transported MCP server: spawned as a child process. */
export interface PluginMcpStdioServerConfig {
  type: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}

/** SSE-transported MCP server: long-lived HTTP+SSE connection. */
export interface PluginMcpSseServerConfig {
  type: 'sse'
  url: string
  headers?: Record<string, string>
}

/** HTTP-transported MCP server: each tool call is a fresh HTTP roundtrip. */
export interface PluginMcpHttpServerConfig {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

/**
 * Serialisable subset of the SDK's MCP server config. Every variant is
 * JSON-roundtrippable so the dashboard's `/plugins` endpoint can render
 * them and the cloud control plane can ferry them between runners and
 * the UI without losing fidelity.
 */
export type PluginMcpServerConfig =
  | PluginMcpStdioServerConfig
  | PluginMcpSseServerConfig
  | PluginMcpHttpServerConfig

// ── Plugin kinds ─────────────────────────────────────────────────────────────

// ── Executor contract re-exports (multi-provider LLM) ───────────────────────
//
// The phase-executor surface is authored in `@coro-ai/plugin-sdk` so external
// LLM provider plugins can implement `PhaseExecutorRuntime` without
// pulling in the runner's transitive deps. The runner re-exports the
// shapes here so internal call sites import from a single place
// (`./plugins/types`) regardless of whether a type is "internal SDK
// shape" or "shared executor shape".
export type {
  PhaseExecutorRuntime,
  PhaseExecutionRequest,
  PhaseExecutorEvent,
  PhaseExecutorMetrics,
  ExecutorCapabilities,
  ExecutorLifecycleHooks,
  ExecutorSessionController,
  DeveloperInputChannel,
  HookPolicy,
  NormalizedTokenUsage,
  ExecutorSessionState,
  ExecutorModelDescriptor,
  ExecutorSubagentSpec,
  McpServerDescriptor,
  ConversationMessage,
  PluginHttpApp,
  PluginHttpRoutesContext,
} from '@coro-ai/plugin-sdk'

/**
 * Open-ended plugin kind. v1 ships `scm` and `tracker`; later cuts may
 * add `notifier`, `observability`, `secrets`, etc. The registry treats
 * unknown kinds as opaque and stores them under their string id so
 * forward compatibility is automatic.
 */
export type PluginKind = 'scm' | 'tracker' | (string & {})

// ── Manifest (static, JSON-serialisable) ─────────────────────────────────────

/**
 * Webhook descriptor a plugin advertises so the cloud can verify HMAC
 * signatures without ever calling into plugin runtime code.
 *
 * `algorithm: 'none'` skips HMAC (used by plugins whose providers don't
 * sign, e.g. classic Jira webhooks — those rely on the URL secret).
 *
 * `format` is the literal shape the provider sends in the signature
 * header. The cloud verifier reproduces it from `algorithm` + secret +
 * raw body and compares with `crypto.timingSafeEqual`.
 */
export interface PluginWebhookDescriptor {
  /**
   * Suffix appended after `/webhook/:teamId/:pluginId`. Most plugins
   * leave this empty; multi-endpoint providers (e.g. one URL per
   * webhook subscription) can split routes here.
   */
  pathSuffix?: string
  algorithm: 'hmac-sha256' | 'hmac-sha1' | 'none'
  /** Header the provider puts the signature in. e.g. `'X-Hub-Signature-256'`. */
  header: string
  /** Literal format: `'sha256=<hex>'`, `'sha1=<hex>'`, `'<hex>'`, `'<plain>'`. */
  format: 'sha256=<hex>' | 'sha1=<hex>' | '<hex>' | '<plain>'
}

/**
 * Markdown the plugin contributes to the per-job intelligence overlay.
 * Paths are relative to the plugin's `intelligence/` root.
 *
 * The resolver copies these into the materialised intelligence dir at
 * job start so agents see them under their normal paths
 * (`.claude/skills/<id>/SKILL.md`, `snippets/<file>.md`, etc.).
 */
export interface PluginIntelligenceContribution {
  /** Skills the plugin contributes (rendered under `.claude/skills/`). */
  skills?: ReadonlyArray<{ id: string; relativePath: string }>
  /** Free-form snippets (e.g. `snippets/scm-conventions.md`). */
  snippets?: ReadonlyArray<{ id: string; relativePath: string }>
}

/**
 * Static, JSON-serialisable plugin metadata.
 *
 * The cloud serialises this into Postgres at tenant configuration time
 * so it can render UI forms and verify webhooks without touching
 * runtime code. The runtime version on the runner can be different
 * from the manifest the cloud holds — `hostCompatibility` exists so
 * the loader refuses to start a plugin whose contract has drifted.
 */
export interface PluginManifest {
  /** Plugin id, unique within the registry (`'github'`, `'@vendor/gitea'`). */
  id: string
  kind: PluginKind
  /** Plugin's own semver version (independent of the runner's). */
  version: string
  /** Human-readable name shown in UIs. */
  displayName: string
  /**
   * Semver range against the runner's host plugin-API version. The
   * v1.5 drop-in loader refuses plugins whose `hostCompatibility`
   * does not satisfy the host's version.
   */
  hostCompatibility: string
  /**
   * Zod schema describing the plugin's `config` shape. Built-in
   * plugins keep the schema typed; the v1.5 loader serialises this to
   * JSON via `zod-to-json-schema` for cloud transport.
   */
  configSchema: ZodTypeAny
  /** Capability flags the agent / UI can branch on (e.g. supportsDraftPr). */
  capabilities?: Record<string, boolean>
  /** Optional — not every plugin emits webhooks. */
  webhook?: PluginWebhookDescriptor
  /** Markdown the resolver merges into the per-job intelligence overlay. */
  intelligence?: PluginIntelligenceContribution
  /**
   * Maps Coro's generic proxy ops (`scm_create_pr`, `tracker_get_issue`,
   * …) to the upstream MCP tool name on this plugin's `mcpServer()`.
   * Only meaningful for plugins that declare an `mcpServer()`. The
   * hybrid `scm_*`/`tracker_*` proxy reads this when an MCP-mode
   * plugin is the active resolver to redirect the agent at the
   * correct native tool name.
   *
   * Example for the `github` plugin:
   * ```
   * { scm_create_pr: 'create_pull_request', scm_get_pr_status: 'get_pull_request' }
   * ```
   */
  mcpToolMap?: Record<string, string>
  /**
   * Optional list of upstream MCP tool names to expose to the agent.
   * The runner threads this into the SDK's per-server tool policy at
   * attach time; tools outside the list are denied. Curated allowlists
   * keep token usage down (large MCPs ship 50–80 tools, agents only
   * need ~15). When omitted, every upstream tool is exposed.
   */
  allowedMcpTools?: ReadonlyArray<string>
  /**
   * Optional list of upstream MCP tool names to deny. Combined with
   * {@link allowedMcpTools} when both are present.
   */
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

// ── Plugin runtime — common ──────────────────────────────────────────────────

/**
 * Plugin authors get a tightly-scoped dependency bag. Notably absent:
 * filesystem, child_process, the state backend, the runner's MCP
 * server. Plugins must not reach for global state — every interesting
 * dependency is injected through this interface so the conformance
 * test pack can mock it deterministically.
 */
export interface PluginDeps {
  logger: Logger
  /** Standard fetch — overridable in tests. */
  fetch: typeof fetch
}

/**
 * Health probe result. `ok: true` means the plugin can talk to its
 * provider with the supplied config; `ok: false` carries a short
 * `reason` the dashboard surfaces directly to the operator.
 */
export interface PluginHealth {
  ok: boolean
  reason?: string
}

/**
 * One step in a multi-step credential probe — surfaced as a bullet
 * under the test button.
 *
 * Mirrors {@link import('@coro-ai/plugin-sdk').PluginTestCheck} — the
 * shapes are duplicated (not re-exported) so the runner stays
 * importable without the SDK package, same as `PluginHealth`. The
 * conformance pack checks both shapes stay in lock-step.
 */
export interface PluginTestCheck {
  name: string
  ok: boolean
  message: string
  hint?: string
}

/**
 * Result of {@link PluginRuntime.testConnection}.
 * Mirrors {@link import('@coro-ai/plugin-sdk').PluginTestResult}.
 */
export interface PluginTestResult {
  ok: boolean
  message?: string
  hint?: string
  checks?: ReadonlyArray<PluginTestCheck>
}

/**
 * Common runtime contract every plugin honours, regardless of kind.
 * Kind-specific extensions live below ({@link ScmPluginRuntime},
 * {@link TrackerPluginRuntime}).
 */
export interface PluginRuntime<Config = unknown> {
  manifest: PluginManifest
  /**
   * One-shot initialisation. Called by the registry exactly once after
   * the runtime is instantiated. May validate `config` and throw on
   * malformed shape (the registry surfaces the error to the user).
   */
  init(config: Config, deps: PluginDeps): Promise<void>
  /**
   * Quick liveness check. Should return within a second or two.
   * Plugins may cache their last successful check internally; the
   * registry calls this on demand from the dashboard's health page.
   */
  healthcheck(): Promise<PluginHealth>
  /**
   * Optional teardown. Plugins holding sockets or background timers
   * should release them here. Most plugins are stateless and can
   * leave this as a no-op.
   */
  dispose(): Promise<void>
  /**
   * Absolute filesystem path the resolver consults for the plugin's
   * intelligence contributions. Built-in plugins return their
   * `__dirname/intelligence`; the v1.5 drop-in loader returns
   * `~/.coro/plugins/<id>/intelligence`. May be omitted when the
   * plugin contributes no intelligence.
   *
   * Kept distinct from {@link PluginManifest.intelligence} because the
   * manifest is JSON-serialisable (sent to the cloud) while the
   * intelligence root is a runner-local filesystem detail.
   */
  intelligenceRoot?(): string | undefined
  /**
   * External MCP server descriptor. When present, the runner attaches
   * the server to every job's `query()` session under the registration
   * key `<pluginId>` so the agent sees its tools as
   * `mcp__<pluginId>__<toolName>`. This is the primary outbound channel
   * after the MCP-first pivot — provider clients (GitHub, Jira, Linear)
   * are served by upstream MCP servers rather than re-implemented in
   * Coro's plugin runtimes.
   *
   * Plugins without a usable upstream MCP (currently BitBucket) leave
   * this undefined; the hybrid `scm_*`/`tracker_*` proxy then falls
   * back to the plugin's own native methods.
   *
   * Plugins that want to trim or extend the upstream tool surface can
   * set `capabilities.allowedMcpTools` / `capabilities.disallowedMcpTools`
   * on their manifest — the runner threads those through the SDK's
   * per-server tool policy at attach time.
   */
  mcpServer?(): PluginMcpServerConfig | undefined
  /**
   * Optional HTTP route registration. Plugins that own provider-specific
   * dashboard endpoints (e.g. Anthropic OAuth login flow) implement this
   * to mount their routes onto the runner's Express app. The runner core
   * stays provider-agnostic — adding a new LLM plugin requires zero edits
   * to {@link createRunnerServer}.
   */
  registerHttpRoutes?(ctx: import('@coro-ai/plugin-sdk').PluginHttpRoutesContext): void
  /**
   * Optional active credential probe (see SDK mirror for full notes).
   * Invoked by the runner's `POST /test/llm` / `/test/git` /
   * `/test/tracker` endpoints so every provider-specific test path
   * lives in its own plugin package instead of the runner core.
   */
  testConnection?(config: Config): Promise<PluginTestResult>
}

// ── SCM plugin runtime ───────────────────────────────────────────────────────

export interface ScmCloneInfo {
  /** Clone URL with credentials embedded (or empty if managed by SSH agent). */
  url: string
  /** Extra env vars to inject into git operations (e.g. `GIT_ASKPASS`). */
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

export interface ScmAddReviewersArgs {
  repoSlug: string
  prId: number | string
  /**
   * Provider-specific reviewer identifiers. Bitbucket accepts
   * `{username}` or `{uuid}`; GitHub accepts login names. Display
   * names ("Jane Doe") are rejected by every provider.
   */
  reviewers: ReadonlyArray<string>
}

/**
 * Result of {@link ScmPluginRuntime.resolveUser}. `uuid` is the
 * provider-canonical handle (Bitbucket UUID, GitHub node id, GitLab
 * id-as-string). When the input was an `account_id`-style identifier
 * that we couldn't enrich from the workspace directory, `uuid` may be
 * empty and the caller should rely on `account_id` instead.
 */
export interface ScmUserRef {
  uuid: string
  account_id?: string
  nickname?: string
  display_name?: string
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
  /**
   * Provider-neutral state.
   *  - `open` — accepting commits, not yet merged.
   *  - `merged` — landed on the target branch.
   *  - `declined` — rejected without merging (closed, declined, etc.).
   */
  state: 'open' | 'merged' | 'declined' | 'superseded'
  approvalCount: number
  /** Number of comments the provider knows about, if cheap to obtain. */
  commentCount?: number
  /** Web URL — rendered in dashboard surface and PR resume prompts. */
  url?: string
}

export interface ScmMergeOptions {
  /** Custom commit message. Provider-defaults apply when omitted. */
  message?: string
  /** `merge` (default), `squash`, or `rebase` — providers may not support all three. */
  strategy?: 'merge' | 'squash' | 'rebase'
}

/**
 * Snapshot used by the polling transport's change-detection loop. The
 * shape mirrors {@link ScmPrStatus} so the polling transport doesn't
 * need to know about any plugin's internal types.
 */
export interface ScmPollSnapshot {
  state: ScmPrStatus['state']
  approvalCount: number
  commentCount: number
  /** Comments currently visible — used to deliver synthetic comment events. */
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
   * snippets array is empty and `pathMatchOnly` is true.
   */
  snippets: ReadonlyArray<{ seq: number; content: string }>
  pathMatchOnly?: boolean
}

/**
 * One entry returned by `ScmPluginRuntime.listFiles`. Minimal shape
 * shared by Bitbucket (`/src/{ref}/{path}`) and GitHub
 * (`/repos/{owner}/{repo}/contents/{path}`) so plan-mode tools don't
 * have to know which provider rendered the listing.
 */
export interface ScmDirectoryEntry {
  /** Path relative to the repository root, e.g. "src/foo/Bar.cs". */
  path: string
  /** Entry kind. `file` = readable via `readFile`, `dir` = traversable. */
  type: 'file' | 'dir'
}

export interface ScmPluginRuntime<Config = unknown> extends PluginRuntime<Config> {
  kind: 'scm'

  // ── Repo / clone ────────────────────────────────────────────────────────
  // `cloneInfo` and `matchesRemote` stay required — they have no MCP
  // equivalent (the credentialed clone URL must come from the plugin
  // itself, and webhook ingress needs a host check). Everything else
  // is optional after the MCP-first pivot: a plugin that exposes an
  // upstream MCP server via `mcpServer()` can omit these methods, and
  // the hybrid `scm_*` proxy will forward calls through the SDK's MCP
  // client instead.
  cloneInfo(args: { repo: string }): ScmCloneInfo
  createRepo?(args: ScmCreateRepoArgs): Promise<ExternalRef>

  // ── Pull requests ───────────────────────────────────────────────────────
  // Each of the methods below is now optional. Plugins serving the
  // operation through their MCP server omit the method; plugins
  // without a usable upstream MCP (currently BitBucket) keep
  // implementing them and the `scm_*` proxy falls back to them.
  createPr?(args: ScmCreatePrArgs): Promise<ExternalRef>
  /**
   * Add reviewers to an already-open PR. The plugin merges with any
   * existing reviewers (no replacement). Used by the merge gatekeeper
   * when a developer asks to loop in another reviewer mid-flight.
   */
  addReviewers?(args: ScmAddReviewersArgs): Promise<void>
  /**
   * Resolve a free-form user query (name, nickname, display name,
   * uuid, account_id) to a rich identity record. Returns `null` when
   * nothing matches. Used by the `scm_resolve_user` MCP tool so the
   * agent can map a human-readable identity to the right provider
   * identifier before calling `addReviewers`.
   */
  resolveUser?(query: string): Promise<ScmUserRef | null>
  getPrStatus?(ref: ExternalRef): Promise<ScmPrStatus>
  listPrComments?(ref: ExternalRef): Promise<ScmPrComment[]>
  postPrComment?(ref: ExternalRef, body: string): Promise<ScmPrComment>
  replyToComment?(ref: ExternalRef, parentId: string, body: string): Promise<ScmPrComment>
  approvePr?(ref: ExternalRef): Promise<void>
  mergePr?(ref: ExternalRef, opts?: ScmMergeOptions): Promise<void>

  /** Read a single file via the SCM provider REST API (plan mode). */
  readFile?(args: { repo: string; path: string; ref?: string }): Promise<ScmReadFileResult>
  /** Search code in a repository via the SCM provider REST API. */
  searchCode?(args: { repo: string; query: string; maxResults?: number }): Promise<ReadonlyArray<ScmCodeSearchHit>>
  /**
   * List entries in a repository directory. Lets the plan-mode agent
   * discover repo structure without cloning. `path` defaults to the
   * root, `ref` to the default branch.
   */
  listFiles?(args: { repo: string; path?: string; ref?: string }): Promise<ReadonlyArray<ScmDirectoryEntry>>

  // ── Self-improvement writer escape hatch ────────────────────────────────
  /**
   * Open a proposal PR from an outside-of-`query()` context. Used
   * **only** by `intelligence/writer.ts` to ship `propose_change`
   * payloads. The agent never sees this method.
   *
   * Why a dedicated method instead of just calling `createPr`?
   *   The self-improvement writer runs synchronously in the runner's
   *   event loop, *not* inside an SDK `query()` session. That means
   *   the upstream MCP server attached via `mcpServer()` is
   *   unreachable here — there is no `query()` tool-use loop that
   *   could route a `mcp__github__create_pull_request` call back to
   *   the spawned MCP process. So MCP-mode plugins still need a
   *   minimal native PR-creation path for this single use case, and
   *   we name it explicitly so it's clear it is not a workaround
   *   reachable from agent code.
   *
   *   When the SDK or our plumbing learns to invoke MCP tools
   *   programmatically from arbitrary TS, this method goes away in
   *   favour of routing through `mcpServer()`. Until then, this is
   *   the documented native fallback for both BitBucket (no MCP
   *   today) and GitHub (MCP-mode but with a tiny inline native
   *   client retained for `pollPr`, reused here).
   */
  writerCreatePr?(args: ScmCreatePrArgs): Promise<ExternalRef>

  // ── Polling (replaces PrPoller) ─────────────────────────────────────────
  /**
   * Single call returning the data the polling transport needs to
   * detect change without making the transport choose between
   * `getPrStatus` and `listPrComments`. The polling transport calls
   * this on every cycle for every parked job that's awaiting an
   * `external_ref`.
   *
   * Polling runs OUTSIDE an active `query()` session, so it cannot
   * use the upstream MCP server attached at job start. Plugins keep
   * a tiny native fetch (HTTP or `fetch`) for this single method even
   * after migrating to MCP mode for the agent-facing operations.
   */
  pollPr(ref: ExternalRef): Promise<ScmPollSnapshot>

  // ── Webhook normalisation ───────────────────────────────────────────────
  /**
   * Turn a raw webhook (headers + body) into a NormalizedEvent. Returns
   * `null` when the payload is something the plugin chooses to ignore
   * (e.g. ping events, unrecognised event keys). The dispatcher
   * tolerates `null` and drops the event silently.
   */
  normalizeInbound(req: { headers: Record<string, string | string[] | undefined>; rawBody: Buffer }): NormalizedEvent | null

  // ── Resolution ──────────────────────────────────────────────────────────
  /**
   * Used by `intelligence/writer.ts` to pick a plugin from a remote
   * URL when opening a self-improvement proposal PR. Implementations
   * typically check the URL host (`github.com`, `bitbucket.org`).
   */
  matchesRemote(remoteUrl: string): boolean
}

// ── Tracker plugin runtime ───────────────────────────────────────────────────

export interface TrackerIssue {
  /** Provider-native key (`'PROJ-123'`, `'42'`, `'ENG-7'`). */
  key: string
  /** Web URL. */
  url: string
  /** Title / one-line summary. */
  summary: string
  /** Provider-native status name (e.g. `'In Progress'`). */
  status: string
  /** Issue body / description when available. */
  description?: string
  /** Issuetype name where the provider has one. */
  issueType?: string
  /** Parent issue / epic key. */
  parentKey?: string
}

export interface TrackerCreateIssueArgs {
  /** Provider-specific scope: Jira project key, GH repo, Linear team. */
  projectKey: string
  summary: string
  description: string
  issueType?: string
  parentKey?: string
  labels?: ReadonlyArray<string>
}

export interface TrackerCreateEpicArgs {
  projectKey: string
  summary: string
  description: string
  labels?: ReadonlyArray<string>
}

export interface TrackerLinkIssuesArgs {
  fromKey: string
  toKey: string
  /** Provider-native relation; `'Blocks'` is the campaign-planner default. */
  relation: 'Blocks' | 'Relates' | (string & {})
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
}

export interface TrackerCommentArgs {
  key: string
  body: string
}

export interface TrackerTransitionArgs {
  key: string
  /** Target status name (provider-specific, e.g. `'Done'`). */
  status: string
}

export interface TrackerPluginRuntime<Config = unknown> extends PluginRuntime<Config> {
  kind: 'tracker'

  // ── Read ────────────────────────────────────────────────────────────────
  // After the MCP-first pivot every operation is optional. Plugins
  // backed by an upstream MCP server (Jira via Atlassian MCP, Linear,
  // GitHub Issues via the GitHub MCP) drop these methods and the
  // hybrid `tracker_*` proxy forwards through MCP instead.
  getIssue?(key: string): Promise<TrackerIssue>
  searchIssues?(query: string, limit?: number): Promise<TrackerIssue[]>
  listChildren?(parentKey: string): Promise<TrackerIssue[]>
  /**
   * Read the comment thread on an issue. Comments are intentionally NOT
   * folded into {@link TrackerIssue} so reading them is an explicit,
   * opt-in call. MCP-mode plugins may omit this and map
   * `tracker_get_comments` to an upstream tool via `manifest.mcpToolMap`.
   */
  getComments?(key: string): Promise<TrackerComment[]>

  // ── Write ───────────────────────────────────────────────────────────────
  commentIssue?(args: TrackerCommentArgs): Promise<void>
  transitionIssue?(args: TrackerTransitionArgs): Promise<void>
  createIssue?(args: TrackerCreateIssueArgs): Promise<TrackerIssue>
  createEpic?(args: TrackerCreateEpicArgs): Promise<TrackerIssue>
  linkIssues?(args: TrackerLinkIssuesArgs): Promise<void>

  // ── Prompt surface ──────────────────────────────────────────────────────
  /**
   * Provider-specific defaults the runner injects into the agent
   * job-context block as `tracker.defaults`. Keys are intentionally
   * provider-specific (e.g. `owner` for GitHub Issues, `teamKey` for
   * Linear) so the agent prompt can reference them unambiguously.
   * Return `undefined` when no defaults are configured.
   */
  promptDefaults?(): Record<string, string> | undefined

  // ── Webhook normalisation (optional) ────────────────────────────────────
  /** Trackers without webhook support return `null` from every call. */
  normalizeInbound?(req: { headers: Record<string, string | string[] | undefined>; rawBody: Buffer }): NormalizedEvent | null
}

// ── Plugin extension MCP tools ───────────────────────────────────────────────

/**
 * Plugins may register provider-specific MCP tools that don't fit the
 * generic `scm_*` / `tracker_*` surface (e.g. `gh_create_release`,
 * `bb_pipeline_run`).
 *
 * The schema is intentionally a thin wrapper around the SDK's `tool()`
 * factory so plugin authors can plug straight into the existing
 * registration helper without learning a Coro-specific API.
 *
 * `name` is registered verbatim — by convention it carries the plugin
 * id as a prefix (`gh_`, `bb_`) so collisions across plugins are
 * rejected by the registry rather than silently overwriting.
 */
export interface PluginMcpToolDefinition {
  name: string
  description: string
  /** Zod input shape — `Record<string, ZodTypeAny>` matches the SDK's `tool()` factory. */
  inputSchema: Record<string, ZodTypeAny>
  /**
   * Handler — receives validated args, returns a JSON-serialisable
   * result. Plugins should never throw `unknown` from here; wrap
   * caught errors in `Error(message)` so the SDK's MCP frame is
   * well-formed.
   */
  handler: (args: Record<string, unknown>) => Promise<unknown>
  /** Optional read-only / safety annotation passed through to the SDK. */
  annotations?: { readOnlyHint?: boolean }
}

/**
 * Optional `extensionTools()` method on a plugin runtime — the
 * registry harvests these once at boot and registers them under
 * `mcp__coro__<name>` alongside the generic `scm_*` / `tracker_*`
 * tools.
 */
export interface PluginExtensionToolProvider {
  extensionTools?(): PluginMcpToolDefinition[]
}

// Exported for downstream type consumers that need the union of all
// plugin runtime shapes (e.g. `Array<AnyPluginRuntime>` in test
// fixtures).
export type AnyPluginRuntime =
  | (ScmPluginRuntime & PluginExtensionToolProvider)
  | (TrackerPluginRuntime & PluginExtensionToolProvider)
  | (PluginRuntime & PluginExtensionToolProvider)
