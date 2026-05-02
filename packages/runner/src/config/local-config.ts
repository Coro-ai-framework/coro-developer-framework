// ── Local config reader/writer (~/.coro/config.json) ─────────────────────────
//
// Manages the runner's local configuration file. In hybrid mode this holds the
// cloud URL, runner token, and Anthropic API key. In local mode, it stores
// paths and git credentials. The runner reads this at startup to determine its
// deployment mode.

import fs from 'fs'
import path from 'path'
import os from 'os'
import { z } from 'zod'
import type { TenantOverlaySource } from '../intelligence/tenant-context'

// ── Schema ───────────────────────────────────────────────────────────────────

const cloudConfigSchema = z.object({
  url: z.string().url(),
  token: z.string().min(1),
}).optional()

const claudeAccountSchema = z.object({
  email: z.string().optional(),
  organization: z.string().optional(),
  subscriptionType: z.string().optional(),
  tokenSource: z.string().optional(),
  apiKeySource: z.string().optional(),
  apiProvider: z.enum(['firstParty', 'bedrock', 'vertex', 'foundry', 'anthropicAws', 'mantle']).optional(),
}).optional()

// Anthropic auth supports three modes:
//   - apiKey: direct Anthropic API key (production, billed per token)
//   - oauth: legacy long-lived Claude Code OAuth token from `claude setup-token`
//   - claudeLogin: Claude Code manages its own persisted login session locally;
//                  we only store the selected mode plus optional account metadata
// The method field is optional/defaulted so that legacy configs containing only
// `{ apiKey: "..." }` continue to load. The refine() guarantees that the chosen
// method has a matching non-empty credential.
const anthropicConfigSchema = z
  .object({
    method: z.enum(['apiKey', 'oauth', 'claudeLogin']).default('apiKey'),
    apiKey: z.string().optional(),
    oauthToken: z.string().optional(),
    account: claudeAccountSchema,
  })
  .refine(
    v =>
      (v.method === 'apiKey' && typeof v.apiKey === 'string' && v.apiKey.length > 0) ||
      (v.method === 'oauth' && typeof v.oauthToken === 'string' && v.oauthToken.length > 0) ||
      v.method === 'claudeLogin',
    {
      message:
        'Anthropic config requires apiKey when method="apiKey", oauthToken when method="oauth", or method="claudeLogin"',
    },
  )

// Both fields are optional individually — `resolveIntelligenceDir`
// already falls back to `defaultIntelligenceDir()` when `dir` is unset.
// When `tenant.overlay` is omitted, `resolveTenantOverlaySource()`
// maps a non-empty `intelligence.gitRemote` to a `gitRemote` tenant overlay
// so `propose_change` and the resolver see the same repo the dashboard
// “Intelligence Git Remote” field configures. A user entering only one
// field must round-trip through GET /config without disappearing.
const intelligenceConfigSchema = z.object({
  dir: z.string().min(1).optional(),
  gitRemote: z.string().min(1).optional(),
}).optional()

// ── Tenant overlay (Phase 4) ─────────────────────────────────────────────────
//
// Solo deployments can opt-in to a tenant-level intelligence overlay by
// declaring it here. The runner reads this field at bootstrap and feeds
// it into the synthesised TenantContext.
//
// The variants here MUST match `TenantOverlaySource` in
// `packages/runner/src/intelligence/tenant-context.ts`. Validation and
// option resolution are zod-driven so a malformed config fails loudly.

const tenantOverlaySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('localDir'), path: z.string().min(1) }),
  z.object({ kind: z.literal('gitRemote'), url: z.string().min(1), ref: z.string().optional() }),
  z.object({ kind: z.literal('cloudBlob'), key: z.string().min(1) }),
])

const tenantConfigSchema = z.object({
  /**
   * Optional explicit display name override. When omitted the bootstrap
   * uses `Solo (<host>)` for the synthesized solo tenant.
   */
  displayName: z.string().optional(),
  /** Where this tenant's intelligence overlay lives. */
  overlay: tenantOverlaySchema.optional(),
}).optional()

const pathsConfigSchema = z.object({
  workingDir: z.string().min(1),
}).optional()

const gitConfigSchema = z.object({
  provider: z.enum(['bitbucket', 'github', 'gitlab']),
  workspace: z.string().optional(),
  username: z.string().min(1),
  token: z.string().min(1),
}).optional()

// ── Proposals ────────────────────────────────────────────────────────────────
//
// Controls the self-improvement loop. Today there is exactly one knob —
// the routing strategy — but we keep the shape nested so future seams
// (auto-approval categories, runner-side coalescing, etc.) can land
// without breaking the wire format of saved configs.
//
// `routing.strategy`:
//   - `path`  — file path prefix decides the target layer (`.coro/...` →
//               repo, anything else → tenant). Deterministic; recommended.
//   - `agent` — agents must pass an explicit `targetLayer` and the tool
//               only validates it for consistency. Reserved for future use.
//
// The schema is optional everywhere so legacy configs without a
// `proposals` block continue to load. `resolveProposalsConfig()` below
// fills in the canonical defaults at read time.

const proposalsConfigSchema = z.object({
  routing: z.object({
    strategy: z.enum(['path', 'agent']).optional(),
  }).optional(),
}).optional()

// ── Issue tracker (campaign workflow) ────────────────────────────────────────
//
// The campaign workflow's planner/evaluator agents talk to an external issue
// tracker via the `TrackerClient` abstraction. The tenant chooses the
// provider here; when set to `'github'` the runner reuses the credentials
// from the `git` block (no need to re-enter a token). Jira and Linear get
// their own credential sub-objects since they are unrelated to the git
// provider.
//
// All inner credential fields are optional so a partially-filled tracker
// block round-trips cleanly through GET/PUT — useful when the user is
// switching providers in the dashboard but hasn't filled in the new one
// yet. The factory in `clients/tracker/index.ts` falls back to the
// "stub" client when credentials are missing, which is what `provider:
// 'none'` also produces.
const trackerConfigSchema = z.object({
  provider: z.enum(['none', 'jira', 'github', 'linear']).optional(),
  jira: z.object({
    baseUrl: z.string().optional(),
    username: z.string().optional(),
    apiToken: z.string().optional(),
  }).optional(),
  linear: z.object({
    apiKey: z.string().optional(),
    teamKey: z.string().optional(),
  }).optional(),
}).optional()

const localConfigSchema = z.object({
  cloud: cloudConfigSchema,
  anthropic: anthropicConfigSchema,
  intelligence: intelligenceConfigSchema,
  paths: pathsConfigSchema,
  git: gitConfigSchema,
  tenant: tenantConfigSchema,
  proposals: proposalsConfigSchema,
  tracker: trackerConfigSchema,
})

export type LocalConfig = z.infer<typeof localConfigSchema>

// ── Deployment mode ──────────────────────────────────────────────────────────

export type DeploymentMode = 'hybrid' | 'local'

/**
 * Determine deployment mode from config:
 *   - hybrid: cloud URL + token present → runner connects to cloud
 *   - local:  everything else → SQLite + polling on the developer's machine
 */
export function detectMode(config: LocalConfig | null): DeploymentMode {
  if (config?.cloud?.url && config.cloud.token) return 'hybrid'
  return 'local'
}

// ── Default paths ────────────────────────────────────────────────────────────

export function defaultConfigDir(): string {
  return path.join(os.homedir(), '.coro')
}

export function defaultConfigPath(): string {
  return path.join(defaultConfigDir(), 'config.json')
}

export function defaultIntelligenceDir(): string {
  return path.join(defaultConfigDir(), 'intelligence')
}

export function defaultWorkingDir(): string {
  return path.join(defaultConfigDir(), 'working')
}

/**
 * Cache root for intelligence loader artifacts (e.g. cloned tenant
 * overlay repos). Lives under the config dir so the runner doesn't
 * pollute the per-job working dirs.
 */
export function defaultLoaderCacheRoot(): string {
  return path.join(defaultConfigDir(), 'cache', 'tenant-overlays')
}

/**
 * Cache root for the proposal writer's working clones.
 *
 * Separate from `defaultLoaderCacheRoot()` because the loader's clones
 * are shallow + `--single-branch` + hard-reset on every job, which
 * makes them unsuitable for hosting the long-lived feature branches
 * the writer needs. Each `<tenantId>/<layer>/` subdir holds a full
 * clone the writer can branch off and push from.
 */
export function defaultWriterCacheRoot(): string {
  return path.join(defaultConfigDir(), 'cache', 'writers')
}

// ── Read / Write ─────────────────────────────────────────────────────────────

/**
 * Load config from the given path (default: ~/.coro/config.json).
 * Returns null if the file doesn't exist. Throws on invalid content —
 * callers that need to recover from a corrupt file should use
 * `loadLocalConfigRaw` instead.
 */
export function loadLocalConfig(configPath?: string): LocalConfig | null {
  const p = configPath ?? defaultConfigPath()
  if (!fs.existsSync(p)) return null

  const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
  return localConfigSchema.parse(raw)
}

/**
 * Resilient variant of `loadLocalConfig` that distinguishes "file missing"
 * from "file present but malformed". Used by the HTTP API so a bad save
 * from a previous session doesn't permanently 500 the dashboard — instead
 * the dashboard can render the offending payload alongside a "please
 * re-save" banner and the next valid PUT overwrites it cleanly.
 */
export type LoadLocalConfigResult =
  | { kind: 'missing' }
  | { kind: 'ok'; config: LocalConfig }
  | { kind: 'invalid'; raw: unknown; error: Error }

export function loadLocalConfigRaw(configPath?: string): LoadLocalConfigResult {
  const p = configPath ?? defaultConfigPath()
  if (!fs.existsSync(p)) return { kind: 'missing' }

  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch (err) {
    return { kind: 'invalid', raw: null, error: err as Error }
  }

  const parsed = localConfigSchema.safeParse(raw)
  if (parsed.success) return { kind: 'ok', config: parsed.data }
  return { kind: 'invalid', raw, error: new Error(parsed.error.message) }
}

/**
 * Validate a candidate config without touching the filesystem.
 *
 * Returns either a fully-typed `LocalConfig` (after zod has applied
 * defaults/coercion) or a list of human-readable issues. Used by the
 * `PUT /config` handler to fail-fast with a 400 rather than writing a
 * payload that would break subsequent reads.
 */
export type ValidateLocalConfigResult =
  | { success: true; config: LocalConfig }
  | { success: false; issues: { path: string; message: string }[] }

export function validateLocalConfig(candidate: unknown): ValidateLocalConfigResult {
  const parsed = localConfigSchema.safeParse(candidate)
  if (parsed.success) return { success: true, config: parsed.data }
  return {
    success: false,
    issues: parsed.error.issues.map(i => ({
      path: i.path.join('.') || '(root)',
      message: i.message,
    })),
  }
}

/**
 * Write config atomically. Creates parent directories if needed.
 */
export function saveLocalConfig(config: LocalConfig, configPath?: string): void {
  const p = configPath ?? defaultConfigPath()
  const dir = path.dirname(p)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
}

/**
 * Merge partial config into existing. Useful for `coro login` which only sets cloud fields.
 */
export function mergeLocalConfig(patch: Partial<LocalConfig>, configPath?: string): LocalConfig {
  // Fallback seeds `method: 'apiKey'` so the zod refine doesn't reject the
  // intermediate value; callers are expected to patch in the real credentials.
  const existing: LocalConfig =
    loadLocalConfig(configPath) ?? { anthropic: { method: 'apiKey', apiKey: '__placeholder__' } }
  const merged: LocalConfig = {
    ...existing,
    ...patch,
    // Deep merge sub-objects
    cloud: patch.cloud !== undefined ? patch.cloud : existing.cloud,
    anthropic: patch.anthropic ?? existing.anthropic,
    intelligence: patch.intelligence !== undefined ? patch.intelligence : existing.intelligence,
    paths: patch.paths !== undefined ? patch.paths : existing.paths,
    git: patch.git !== undefined ? patch.git : existing.git,
    tenant: patch.tenant !== undefined ? patch.tenant : existing.tenant,
    proposals: patch.proposals !== undefined ? patch.proposals : existing.proposals,
    tracker: patch.tracker !== undefined ? patch.tracker : existing.tracker,
  }
  saveLocalConfig(merged, configPath)
  return merged
}

/**
 * Resolve the effective intelligence directory. Falls back to the default.
 */
export function resolveIntelligenceDir(config: LocalConfig | null): string {
  return config?.intelligence?.dir?.replace('~', os.homedir()) ?? defaultIntelligenceDir()
}

/**
 * Resolve the effective working directory. Falls back to the default.
 */
export function resolveWorkingDir(config: LocalConfig | null): string {
  return config?.paths?.workingDir?.replace('~', os.homedir()) ?? defaultWorkingDir()
}

/**
 * Resolve the proposals routing strategy. Defaults to `path`-based
 * routing (the recommended deterministic mode) when the config block
 * is missing or partial.
 */
export type ResolvedProposalsConfig = {
  routing: { strategy: 'path' | 'agent' }
}

export function resolveProposalsConfig(config: LocalConfig | null): ResolvedProposalsConfig {
  return {
    routing: {
      strategy: config?.proposals?.routing?.strategy ?? 'path',
    },
  }
}

/**
 * Effective tenant overlay for this runner process.
 *
 * - If `tenant.overlay` is set (including `{ kind: 'none' }`), it wins.
 * - Otherwise, a non-empty `intelligence.gitRemote` is treated as
 *   `{ kind: 'gitRemote', url }` — matching the dashboard “Intelligence
 *   Git Remote” field and `coro init`.
 * - Otherwise `{ kind: 'none' }`.
 *
 * This closes the gap where users configured the intelligence repo URL
 * but never added a separate `tenant.overlay` block; `propose_change`
 * requires a `gitRemote` overlay to open tenant-layer PRs.
 */
export function resolveTenantOverlaySource(config: LocalConfig | null): TenantOverlaySource {
  const explicit = config?.tenant?.overlay
  if (explicit !== undefined) return explicit

  const url = typeof config?.intelligence?.gitRemote === 'string' ? config.intelligence.gitRemote.trim() : ''
  if (url.length > 0) {
    return { kind: 'gitRemote', url }
  }

  return { kind: 'none' }
}
