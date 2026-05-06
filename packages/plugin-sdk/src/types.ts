// ── Plugin SDK types ─────────────────────────────────────────────────────────
//
// Public, authoring-side mirror of the runner's `plugins/types.ts` and
// `plugins/refs.ts`. We deliberately *duplicate* (rather than re-export
// from `@coro/runner`) so:
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

import type { Logger } from 'pino'
import type { ZodTypeAny } from 'zod'

// ── External references ──────────────────────────────────────────────────────

export type ExternalRefKind = 'pull_request' | 'ticket' | 'repo' | 'issue'

export interface ExternalRef {
  kind: ExternalRefKind
  pluginId: string
  /** REQUIRED for `kind: 'pull_request'`. */
  repoKey?: string
  externalId: string
  url?: string
}

export interface NormalizedEvent {
  ref: ExternalRef
  /** Plugin-defined high-level event name (e.g. `'pr.merged'`). */
  kind: string
  raw: unknown
  receivedAt: string
}

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

export type PluginKind = 'scm' | 'tracker' | (string & {})

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

export interface PluginRuntime<Config = unknown> {
  manifest: PluginManifest
  init(config: Config, deps: PluginDeps): Promise<void>
  healthcheck(): Promise<PluginHealth>
  dispose(): Promise<void>
  intelligenceRoot?(): string | undefined
  mcpServer?(): PluginMcpServerConfig | undefined
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
