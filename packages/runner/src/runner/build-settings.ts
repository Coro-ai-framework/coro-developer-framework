// ── Settings construction helpers ────────────────────────────────────────────
//
// Pure transforms from the on-disk `LocalConfig` shape into the
// in-memory `Settings` object and per-executor alias defaults.
//
// Extracted from `runner/index.ts` so the hot-reload path
// (`runner/config-reload.ts`) can re-build settings without dragging
// the bootstrap module into a circular import (server.ts → reload →
// index.ts → server.ts).

import { isExecutorPlugin, type PluginRegistry } from '../plugins/registry'
import type { PhaseExecutorRuntime } from '../plugins/types'
import { getBaseLayerRoot } from '@coro-ai/intelligence-base'
import {
  resolveIntelligenceDir,
  resolveProposalsConfig,
  resolveUpstreamConfig,
  resolveWorkingDir as resolveLocalWorkingDir,
  type LocalConfig,
} from '../config/local-config'
import { Settings } from '../config/settings'

function isTierAliasKey(key: string): boolean {
  return key.startsWith('tier:')
}

/** Capability slots every workflow resolves — owned by the preferred executor. */
function isCapabilityAliasKey(key: string): boolean {
  return isTierAliasKey(key) || key === 'planning' || key === 'coding' || key === 'mini'
}

async function readyExecutors(plugins: PluginRegistry): Promise<PhaseExecutorRuntime[]> {
  const out: PhaseExecutorRuntime[] = []
  for (const runtime of plugins.byKind('executor')) {
    if (!isExecutorPlugin(runtime)) continue
    try {
      const health = await runtime.healthcheck()
      if (health.ok) out.push(runtime)
    } catch {
      // Treat a throwing healthcheck as not-ready — same as ok:false.
    }
  }
  return out
}

/**
 * Pick the executor whose `tier:*` defaults should fill empty alias
 * slots. Operator `defaultProvider` wins; otherwise the sole healthy
 * executor. Two healthy executors with no default stay ambiguous and
 * we fall back to first-write-wins among the ready set.
 */
async function preferredExecutor(
  plugins: PluginRegistry,
  defaultProvider: string | undefined,
): Promise<PhaseExecutorRuntime | undefined> {
  if (defaultProvider) {
    const pinned = plugins.byId(defaultProvider)
    if (pinned && isExecutorPlugin(pinned)) return pinned
  }
  const ready = await readyExecutors(plugins)
  if (ready.length === 1) return ready[0]
  return undefined
}

function applyEnvModelOverride(args: {
  plugins: PluginRegistry
  aliases: Record<string, { provider: string; model: string; reasoningEffort?: 'low' | 'medium' | 'high' }>
  model: string
  tier: 'planning' | 'coding'
  defaultProvider: string | undefined
}): void {
  let provider = process.env['CORO_DEFAULT_PROVIDER'] || args.defaultProvider
  if (!provider) {
    try {
      provider = args.plugins.resolveExecutor({ model: args.model }).manifest.id
    } catch {
      provider = undefined
    }
  }
  if (!provider) return
  const entry = { provider, model: args.model }
  args.aliases[`tier:${args.tier}`] = entry
  args.aliases[args.tier] = entry
}

/**
 * Seed `settings.llm.aliases` from each executor plugin's
 * `defaultAliases()`. Operator-supplied aliases (loaded from
 * `LocalConfig`) win over plugin defaults.
 *
 * Provider-specific keys (e.g. `openaiPlanning`) are first-write-wins
 * across every registered executor. Capability slots (`tier:*` and the
 * legacy `planning` / `coding` / `mini` shorthands) come from the
 * preferred executor (configured `defaultProvider`, else the sole
 * healthy executor) so an OpenAI-only install is not shadowed by the
 * auto-loaded Anthropic plugin.
 *
 * Env var overrides (`CORO_PLANNING_MODEL` / `CORO_CODING_MODEL`,
 * plus the deprecated `CLAUDE_*` names) trump everything. Provider is
 * resolved from `CORO_DEFAULT_PROVIDER` or `supports(model)`, never
 * hardcoded.
 *
 * Called from runner bootstrap and also from `reloadRunnerState`
 * after a config write so newly-installed executor plugins seed
 * their aliases into the live `Settings`.
 */
export async function seedExecutorDefaultAliases(args: {
  plugins: PluginRegistry
  settings: Settings
}): Promise<void> {
  const llm = args.settings.llm ?? (args.settings.llm = {})
  const aliases = llm.aliases ?? (llm.aliases = {})
  const preferred = await preferredExecutor(args.plugins, llm.defaultProvider)
  const readyIds = new Set((await readyExecutors(args.plugins)).map(r => r.manifest.id))

  if (!llm.defaultProvider && preferred) {
    llm.defaultProvider = preferred.manifest.id
  }
  if (preferred) {
    args.plugins.setDefaults({
      ...args.plugins.getDefaults(),
      executor: preferred.manifest.id,
    })
  }

  if (preferred && typeof preferred.defaultAliases === 'function') {
    for (const [k, v] of Object.entries(preferred.defaultAliases())) {
      if (!aliases[k]) aliases[k] = v
    }
  }

  for (const runtime of args.plugins.all()) {
    if (!isExecutorPlugin(runtime)) continue
    if (typeof runtime.defaultAliases !== 'function') continue
    if (preferred && runtime.manifest.id === preferred.manifest.id) continue
    for (const [k, v] of Object.entries(runtime.defaultAliases())) {
      if (isCapabilityAliasKey(k)) {
        if (preferred) continue
        if (!readyIds.has(runtime.manifest.id)) continue
      }
      if (!aliases[k]) aliases[k] = v
    }
  }

  // Env overrides trump everything (escape hatch for CI / `docker run`).
  // Model resolution consults `tier:<tier>` *before* the legacy bare
  // `planning`/`coding` keys, so we overwrite both.
  const planEnv = process.env['CORO_PLANNING_MODEL'] || process.env['CLAUDE_PLANNING_MODEL']
  if (planEnv) {
    applyEnvModelOverride({
      plugins: args.plugins,
      aliases,
      model: planEnv,
      tier: 'planning',
      defaultProvider: llm.defaultProvider,
    })
  }
  const codeEnv = process.env['CORO_CODING_MODEL'] || process.env['CLAUDE_CODING_MODEL']
  if (codeEnv) {
    applyEnvModelOverride({
      plugins: args.plugins,
      aliases,
      model: codeEnv,
      tier: 'coding',
      defaultProvider: llm.defaultProvider,
    })
  }
}

/**
 * Build the in-memory `Settings` object the runner hands to its API
 * clients (BitBucket, GitHub, Loki, …) and the job runner. Pure
 * function of `LocalConfig`; legacy disk-based `settings.json`
 * loading was removed along with the Redis monolith.
 *
 * SCM credential source-of-truth lives under
 * `plugins.installed.{bitbucket|github}.config`. The dashboard's FTUE
 * wizard and Settings page both write that shape; this builder reads
 * it back so `Settings.bitbucket` / `Settings.github` (still consumed
 * by the four legacy client factories and the Anthropic executor's
 * env injection) stay populated end-to-end.
 *
 * Env-var overrides remain as a developer escape hatch — useful for
 * CI runs and `docker run` invocations where the user doesn't want to
 * mount a real `~/.coro/config.json`.
 */
export function buildSettingsFromLocal(config: LocalConfig): Settings {
  const intelligenceDir = resolveIntelligenceDir(config)
  const workingDir = resolveLocalWorkingDir(config)

  // Plugin-installed SCM credentials — the single source of truth.
  // Cast through `Record<string, unknown>` because the runner's
  // `LocalConfig` types `installed[id].config` as `unknown` (each
  // plugin owns its own Zod schema and validates at registry init
  // time); we only read string fields here and tolerate absent
  // values.
  const bbInstalled = (config.plugins?.installed?.['bitbucket']?.config ?? {}) as Record<string, unknown>
  const ghInstalled = (config.plugins?.installed?.['github']?.config ?? {}) as Record<string, unknown>
  const readString = (rec: Record<string, unknown>, key: string): string =>
    typeof rec[key] === 'string' ? (rec[key] as string) : ''

  return {
    host: {
      port: 0,
      webhookSecret: '',
      logLevel: process.env.LOG_LEVEL ?? 'info',
    },
    bitbucket: {
      workspace: readString(bbInstalled, 'workspace') || process.env.BITBUCKET_WORKSPACE || '',
      baseUrl: readString(bbInstalled, 'baseUrl') || process.env.BITBUCKET_BASE_URL || 'https://api.bitbucket.org/2.0',
      coderAccount: {
        username: readString(bbInstalled, 'coderUsername'),
        appPassword: readString(bbInstalled, 'coderToken'),
      },
      reviewerAccount: {
        // Reviewer account defaults to the coder account, matching the
        // previous behaviour. The BitBucket plugin's `init()` applies the
        // same fallback for its own internal reviewer client.
        username:
          process.env.BITBUCKET_REVIEWER_USERNAME ||
          readString(bbInstalled, 'reviewerUsername') ||
          readString(bbInstalled, 'coderUsername'),
        appPassword:
          process.env.BITBUCKET_REVIEWER_APP_PASSWORD ||
          readString(bbInstalled, 'reviewerToken') ||
          readString(bbInstalled, 'coderToken'),
      },
    },
    github: {
      owner: readString(ghInstalled, 'owner') || process.env.GITHUB_OWNER || '',
      token: readString(ghInstalled, 'token') || process.env.GITHUB_TOKEN || '',
      baseUrl: readString(ghInstalled, 'baseUrl') || process.env.GITHUB_API_BASE_URL || 'https://api.github.com',
    },
    redis: {
      url: '',
    },
    paths: {
      workingDir,
      coroIntelligenceDir: intelligenceDir,
      baseLayerDir: getBaseLayerRoot(),
    },
    loki: {
      baseUrl: process.env.LOKI_BASE_URL ?? '',
      apiKey: process.env.LOKI_API_KEY ?? '',
      username: process.env.LOKI_USERNAME ?? '',
    },
    tempo: {
      baseUrl: process.env.TEMPO_BASE_URL ?? '',
      apiKey: process.env.TEMPO_API_KEY ?? '',
    },
    ngrok: {
      authToken: '',
      staticDomain: '',
    },
    proposals: resolveProposalsConfig(config),
    upstream: resolveUpstreamConfig(config),
    llm: {
      defaultProvider: config.llm?.defaultProvider,
      providers: {},
      aliases: { ...(config.llm?.aliases ?? {}) },
    },
    intake: {
      toolsEnabled: config.intake?.toolsEnabled !== false,
    },
    jobs: config.jobs
      ? {
          ...(config.jobs.idleWatchdog
            ? { idleWatchdog: { ...config.jobs.idleWatchdog } }
            : {}),
        }
      : undefined,
  }
}
