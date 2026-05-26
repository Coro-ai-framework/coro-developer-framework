// ── Local config reader/writer (~/.coro/config.json) ─────────────────────────
//
// Manages the runner's local configuration file. It carries cloud pairing
// (hybrid mode), local paths, git credentials, and the `plugins.installed`
// blob (executor + SCM + tracker plugin configs). The runner reads this at
// startup to determine its deployment mode and to seed the plugin registry.

import fs from 'fs'
import path from 'path'
import os from 'os'
import { z } from 'zod'
import type { TenantOverlaySource } from '../intelligence/tenant-context'
import { pluginsConfigSchema, type PluginsConfig } from './plugins-config'
import { legacyConfigKeysBehaviour } from '../plugins/deprecation'

// ── Schema ───────────────────────────────────────────────────────────────────

const cloudConfigSchema = z.object({
  url: z.string().url(),
  token: z.string().min(1),
}).optional()

// Anthropic auth supports three modes:
//   - apiKey: direct Anthropic API key (production, billed per token)
//   - oauth: legacy long-lived Claude Code OAuth token from `claude setup-token`
//   - claudeLogin: Claude Code manages its own persisted login session locally;
//                  we only store the selected mode plus optional account metadata
// The legacy top-level `anthropic` block was removed in Phase F of the
// Anthropic-as-plugin migration. Anthropic credentials now live exclusively
// under `plugins.installed.anthropic.config`, validated by the plugin's
// own `configSchema`.

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

// ── BYO (bring-your-own) MCP servers ─────────────────────────────────────────
//
// S8 of the MCP-first plugins pivot. Operators can attach any MCP
// server to every job session without writing a Coro plugin —
// useful for Slack, Sentry, Datadog, internal tooling, or any
// service that already publishes an MCP server.
//
// The shape mirrors what `collectPluginMcpServers()` produces from
// plugin manifests, with two extra fields:
//
//   - `enabled`      — false → skip without removing the entry.
//   - `allowedTools` / `disallowedTools` — translated into the SDK's
//                       per-server tool policy so operators can
//                       silence noisy tools.
//
// The reserved id `coro` is rejected at config-load time (and again
// at attachment time) — Coro's in-process MCP server cannot be
// shadowed.

const mcpStdioServerSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
})

const mcpHttpServerSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
})

const mcpSseServerSchema = z.object({
  type: z.literal('sse'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
})

const userMcpServerSchema = z.discriminatedUnion('type', [
  mcpStdioServerSchema,
  mcpHttpServerSchema,
  mcpSseServerSchema,
]).and(
  z.object({
    enabled: z.boolean().optional(),
    allowedTools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
  }),
)

const mcpServersConfigSchema = z.record(z.string().min(1), userMcpServerSchema).optional()

export type UserMcpServerConfig = z.infer<typeof userMcpServerSchema>
export type UserMcpServersConfig = NonNullable<z.infer<typeof mcpServersConfigSchema>>

// ── LLM (multi-provider) ─────────────────────────────────────────────────────
//
// Persisted counterpart of `Settings.llm`. Lets operators pick a default
// executor plugin and pin alias → {provider, model} mappings without
// editing workflow YAML. Provider configs themselves live under
// `plugins.installed.<id>.config` — no duplication here.

const llmAliasSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
})

const llmConfigSchema = z.object({
  defaultProvider: z.string().min(1).optional(),
  aliases: z.record(z.string().min(1), llmAliasSchema).optional(),
}).optional()

export type LlmConfig = NonNullable<z.infer<typeof llmConfigSchema>>
export type LlmAliasConfig = z.infer<typeof llmAliasSchema>

// ── FTUE / onboarding completion ─────────────────────────────────────────────
//
// Tracks whether the user has finished the first-time setup wizard.
// Persisted server-side so dashboards on a different browser / device
// don't re-prompt the user. The browser localStorage flag is still
// consulted as a fallback when the runner is older than this field.
//
// `skipped` records which required step the user chose to defer (LLM
// or SCM). The dashboard reads this to soften its "click here to
// finish setup" CTA on subsequent visits.

const setupConfigSchema = z.object({
  completedAt: z.string().optional(),
  skipped: z.array(z.enum(['llm', 'scm', 'tracker'])).optional(),
}).optional()

/** Coach mode — safer defaults for new users (interactive checkpoints on). */
const coachModeConfigSchema = z.object({
  enabled: z.boolean().optional(),
  graduateAfterRuns: z.number().int().min(1).optional(),
  totalRuns: z.number().int().min(0).optional(),
  lastRunAt: z.string().optional(),
  graduatedAt: z.string().optional(),
}).optional()

/** New-run intake surface preference (AI chat vs classic form). */
const intakeConfigSchema = z.object({
  mode: z.enum(['ai', 'form', 'ask-each-time']).optional(),
}).optional()

const localConfigSchema = z.object({
  cloud: cloudConfigSchema,
  intelligence: intelligenceConfigSchema,
  paths: pathsConfigSchema,
  git: gitConfigSchema,
  tenant: tenantConfigSchema,
  proposals: proposalsConfigSchema,
  tracker: trackerConfigSchema,
  /**
   * Provider-plugin config — the new uniform shape replacing the
   * per-provider blocks above. When `plugins` is absent the runner
   * synthesises one via {@link legacyConfigToPlugins} so existing
   * configs round-trip without manual edits.
   */
  plugins: pluginsConfigSchema.optional(),
  /**
   * Multi-provider LLM configuration. `defaultProvider` selects the
   * executor plugin used when an alias / phase doesn't pin one
   * explicitly. `aliases` maps workflow-author shorthands like
   * `planning` / `coding` to a concrete `{provider, model}` pair.
   *
   * Provider configs themselves live under `plugins.installed.<id>.config`
   * (validated by the plugin's own zod schema) — this block holds only
   * routing.
   */
  llm: llmConfigSchema,
  /**
   * Bring-your-own MCP servers attached to every job session. Lets
   * operators wire arbitrary MCP servers (Slack, Sentry, internal
   * tooling) without authoring a full Coro plugin. The keys are the
   * MCP server registration ids the agent will see as
   * `mcp__<id>__*`. The reserved id `coro` is rejected.
   */
  mcpServers: mcpServersConfigSchema,
  /**
   * S9 of the MCP-first plugins pivot. When true the runner discovers
   * user-level Claude Code MCP server entries (from
   * `~/.claude.json` and `~/.claude/settings.json`) and attaches
   * them to every job session — same shape as the BYO `mcpServers`
   * block. Operators that already have a curated Claude Code config
   * get every MCP server at once without editing Coro's config.
   *
   * Defaults to `false` because Claude Code configs commonly carry
   * developer-personal entries (Notion, GitHub Personal, etc.) that
   * an operator may not want every job to see.
   */
  inheritClaudeCodeMcps: z.boolean().optional(),
  /**
   * Runner-enforced guardrails. Shipped defaults live in
   * `packages/runner/config/guardrails.defaults.json`; this block
   * holds overrides only (by rule `id`).
   */
  /**
   * First-time setup wizard completion + which optional steps were
   * skipped. Set when the user finishes (or explicitly skips out of)
   * the FTUE wizard so the dashboard doesn't auto-launch it again.
   */
  setup: setupConfigSchema,
  coachMode: coachModeConfigSchema,
  intake: intakeConfigSchema,
  guardrails: z.object({
    enabled: z.boolean().optional(),
    rules: z.array(z.object({
      id: z.string().min(1),
      title: z.string().optional(),
      description: z.string().optional(),
      enabled: z.boolean().optional(),
      on: z.enum(['scm.create_pr', 'scm.merge_pr', 'propose_change', 'tool.before']).optional(),
      check: z.string().min(1).optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      during: z.array(z.string()).optional(),
      workflows: z.array(z.string()).optional(),
      lanes: z.array(z.string()).optional(),
      script: z.string().optional(),
    }).passthrough()).optional(),
  }).optional(),
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

/** User-authored guardrail scripts (`check: script`). */
export function defaultGuardrailsScriptsDir(): string {
  return path.join(defaultConfigDir(), 'guardrails')
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
  // `anthropic` is now optional on disk — first-time bootstraps that
  // haven't run any login flow yet land here with an empty object so
  // downstream merges don't have to special-case the missing-config path.
  const existing: LocalConfig = loadLocalConfig(configPath) ?? {}
  const merged: LocalConfig = {
    ...existing,
    ...patch,
    // Deep merge sub-objects
    cloud: patch.cloud !== undefined ? patch.cloud : existing.cloud,
    intelligence: patch.intelligence !== undefined ? patch.intelligence : existing.intelligence,
    paths: patch.paths !== undefined ? patch.paths : existing.paths,
    git: patch.git !== undefined ? patch.git : existing.git,
    tenant: patch.tenant !== undefined ? patch.tenant : existing.tenant,
    proposals: patch.proposals !== undefined ? patch.proposals : existing.proposals,
    tracker: patch.tracker !== undefined ? patch.tracker : existing.tracker,
    plugins: patch.plugins !== undefined ? patch.plugins : existing.plugins,
    llm: patch.llm !== undefined ? patch.llm : existing.llm,
    mcpServers: patch.mcpServers !== undefined ? patch.mcpServers : existing.mcpServers,
    inheritClaudeCodeMcps:
      patch.inheritClaudeCodeMcps !== undefined ? patch.inheritClaudeCodeMcps : existing.inheritClaudeCodeMcps,
    setup: patch.setup !== undefined ? patch.setup : existing.setup,
    coachMode: patch.coachMode !== undefined ? patch.coachMode : existing.coachMode,
    intake: patch.intake !== undefined ? patch.intake : existing.intake,
  }
  saveLocalConfig(merged, configPath)
  return merged
}

// ── Legacy → PluginsConfig translator ────────────────────────────────────────
//
// v1 keeps the legacy `git`, `github`, `tracker.jira`, `tracker.linear`,
// and `tracker.provider` blocks readable for one release. This translator
// builds an equivalent PluginsConfig from those keys when `plugins` is
// absent, so existing tenants don't have to migrate their config to
// keep working.
//
// The translator is purely additive: it never overrides an explicit
// `plugins` block. Set `installed[<id>].enabled = false` on the
// generated config to opt out of a legacy provider while keeping its
// credentials around for round-tripping.

/**
 * Convert legacy config blocks into a {@link PluginsConfig}. Leaves
 * `defaults.scm` / `defaults.tracker` undefined when the choice is
 * ambiguous so the registry surfaces a clear error rather than
 * silently picking.
 */
export function legacyConfigToPlugins(config: LocalConfig | null): PluginsConfig {
  if (!config) return { installed: {} }

  const installed: PluginsConfig['installed'] = {}

  // ── SCM ──
  if (config.git?.provider === 'bitbucket' && config.git?.workspace && config.git?.username && config.git?.token) {
    installed['bitbucket'] = {
      enabled: true,
      config: {
        workspace: config.git.workspace,
        coderUsername: config.git.username,
        coderToken: config.git.token,
      },
    }
  }
  if (config.git?.provider === 'github' && config.git?.workspace && config.git?.token) {
    installed['github'] = {
      enabled: true,
      config: {
        owner: config.git.workspace,
        token: config.git.token,
      },
    }
  }

  // ── Tracker ──
  if (config.tracker?.jira?.baseUrl && config.tracker.jira.username && config.tracker.jira.apiToken) {
    installed['jira'] = {
      enabled: true,
      config: {
        baseUrl: config.tracker.jira.baseUrl,
        username: config.tracker.jira.username,
        apiToken: config.tracker.jira.apiToken,
      },
    }
  }
  if (config.tracker?.linear?.apiKey) {
    installed['linear'] = {
      enabled: true,
      config: {
        apiKey: config.tracker.linear.apiKey,
        ...(config.tracker.linear.teamKey ? { teamKey: config.tracker.linear.teamKey } : {}),
      },
    }
  }
  // Legacy `tracker.provider: 'github'` reuses the git creds for issues.
  if (config.tracker?.provider === 'github' && config.git?.provider === 'github' && config.git?.token && config.git?.workspace) {
    installed['github-issues'] = {
      enabled: true,
      config: {
        token: config.git.token,
        defaultOwner: config.git.workspace,
      },
    }
  }

  // ── Defaults ──
  // Only set the default when the legacy config makes the choice
  // unambiguous; otherwise leave it for the registry to fall back to
  // "single installed plugin wins" or surface an error.
  const defaults: PluginsConfig['defaults'] = {}
  if (config.git?.provider === 'bitbucket' && installed['bitbucket']) defaults.scm = 'bitbucket'
  else if (config.git?.provider === 'github' && installed['github']) defaults.scm = 'github'

  if (config.tracker?.provider === 'jira' && installed['jira']) defaults.tracker = 'jira'
  else if (config.tracker?.provider === 'linear' && installed['linear']) defaults.tracker = 'linear'
  else if (config.tracker?.provider === 'github' && installed['github-issues']) defaults.tracker = 'github-issues'

  const out: PluginsConfig = { installed }
  if (defaults.scm || defaults.tracker) out.defaults = defaults
  return out
}

/**
 * Resolve the PluginsConfig for this runner: explicit `plugins` block
 * wins, otherwise synthesised via {@link legacyConfigToPlugins}.
 *
 * Stage-aware behaviour (see `plugins/deprecation.ts`):
 *   - N    → reads both shapes; legacy `git`/`tracker` keys feed the translator.
 *   - N+1  → still parses both shapes (silently); CLI prompts only show the new shape.
 *   - N+2  → throws when a legacy `git`/`tracker` block is encountered without
 *            an explicit `plugins` block — operators must migrate.
 */
export function resolvePluginsConfig(config: LocalConfig | null): PluginsConfig {
  // Always synthesise from legacy keys so the result reflects every
  // legacy block (anthropic / git / tracker). When the user has
  // hand-authored a `plugins` block, it wins per-id — explicit
  // entries override the synthesised ones, but absent ids still
  // fall back to the legacy translation. Without this merge a
  // partial `plugins` block (e.g. only `bitbucket`) would silently
  // drop the legacy `anthropic` entry.
  const synthesised = legacyConfigToPlugins(config)
  if (config?.plugins) {
    const stage = legacyConfigKeysBehaviour()
    if (stage === 'error' && (config.git || config.tracker)) {
      throw new Error(
        `Legacy 'git'/'tracker' top-level config keys are no longer supported. ` +
        `Move them into a 'plugins.installed' block. ` +
        `Run 'coro init' to regenerate the config in the new shape.`,
      )
    }
    return {
      defaults: config.plugins.defaults ?? synthesised.defaults,
      installed: { ...synthesised.installed, ...config.plugins.installed },
    }
  }
  const stage = legacyConfigKeysBehaviour()
  if (stage === 'error' && config && (config.git || config.tracker)) {
    throw new Error(
      `Legacy 'git'/'tracker' top-level config keys are no longer supported. ` +
      `Move them into a 'plugins.installed' block. ` +
      `Run 'coro init' to regenerate the config in the new shape.`,
    )
  }
  return synthesised
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

// ── Claude Code MCP discovery (S9) ───────────────────────────────────────────
//
// Reads user-level Claude Code config files and returns the
// `mcpServers` block(s) merged into a single
// `Record<id, UserMcpServerConfig>`. Order of precedence (later wins):
//
//   1. `~/.claude.json`                  — the default Claude Code config
//   2. `~/.claude/settings.json`         — explicit user-scope settings
//
// Both files are optional. Malformed JSON or missing `mcpServers`
// blocks are silently ignored — a user-level Claude Code config that
// existed long before Coro was installed must never break a job
// run. The runner combines this output with `mcpServers` from
// `~/.coro/config.json` at attachment time so the agent sees one
// coherent set of `mcp__<id>__*` tools.

export interface ClaudeCodeDiscovery {
  servers: Record<string, UserMcpServerConfig>
  sources: ReadonlyArray<string>
}

export function discoverClaudeCodeMcpServers(): ClaudeCodeDiscovery {
  const home = os.homedir()
  const candidates = [
    path.join(home, '.claude.json'),
    path.join(home, '.claude', 'settings.json'),
  ]
  const servers: Record<string, UserMcpServerConfig> = {}
  const sources: string[] = []

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    } catch {
      continue
    }
    if (!raw || typeof raw !== 'object') continue
    const block = (raw as Record<string, unknown>)['mcpServers']
    if (!block || typeof block !== 'object') continue
    let imported = 0
    for (const [id, entry] of Object.entries(block as Record<string, unknown>)) {
      const normalised = normaliseClaudeMcpEntry(entry)
      if (!normalised) continue
      servers[id] = normalised
      imported += 1
    }
    if (imported > 0) sources.push(filePath)
  }

  return { servers, sources }
}

function normaliseClaudeMcpEntry(entry: unknown): UserMcpServerConfig | undefined {
  if (!entry || typeof entry !== 'object') return undefined
  const obj = entry as Record<string, unknown>
  // Claude Code config commonly omits `type` for stdio servers — they
  // declare `command` directly. We default to `'stdio'` in that case.
  const explicitType = typeof obj['type'] === 'string' ? (obj['type'] as string) : undefined
  const type = explicitType ?? (typeof obj['command'] === 'string' ? 'stdio' : undefined)
  if (type === 'stdio') {
    if (typeof obj['command'] !== 'string' || obj['command'].length === 0) return undefined
    return {
      type: 'stdio',
      command: obj['command'] as string,
      ...(Array.isArray(obj['args']) ? { args: (obj['args'] as unknown[]).filter((a): a is string => typeof a === 'string') } : {}),
      ...(obj['env'] && typeof obj['env'] === 'object' ? { env: obj['env'] as Record<string, string> } : {}),
    }
  }
  if (type === 'http' || type === 'sse') {
    if (typeof obj['url'] !== 'string' || obj['url'].length === 0) return undefined
    return {
      type,
      url: obj['url'],
      ...(obj['headers'] && typeof obj['headers'] === 'object' ? { headers: obj['headers'] as Record<string, string> } : {}),
    }
  }
  return undefined
}
