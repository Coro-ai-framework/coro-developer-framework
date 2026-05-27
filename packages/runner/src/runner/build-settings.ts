// ── Settings construction helpers ────────────────────────────────────────────
//
// Pure transforms from the on-disk `LocalConfig` shape into the
// in-memory `Settings` object and per-executor alias defaults.
//
// Extracted from `runner/index.ts` so the hot-reload path
// (`runner/config-reload.ts`) can re-build settings without dragging
// the bootstrap module into a circular import (server.ts → reload →
// index.ts → server.ts).

import type { PluginRegistry } from '../plugins/registry'
import { getBaseLayerRoot } from '@coro-ai/intelligence-base'
import {
  resolveIntelligenceDir,
  resolveProposalsConfig,
  resolveWorkingDir as resolveLocalWorkingDir,
  type LocalConfig,
} from '../config/local-config'
import { Settings } from '../config/settings'

/**
 * Seed `settings.llm.aliases` from each executor plugin's
 * `defaultAliases()`. Operator-supplied aliases (loaded from
 * `LocalConfig`) win over plugin defaults. Env var overrides
 * (`CLAUDE_PLANNING_MODEL` / `CLAUDE_CODING_MODEL`) trump everything
 * for back-compat with the pre-Phase-C bootstrap behaviour.
 *
 * Called from runner bootstrap and also from `reloadRunnerState`
 * after a config write so newly-installed executor plugins seed
 * their aliases into the live `Settings`.
 */
export function seedExecutorDefaultAliases(args: {
  plugins: PluginRegistry
  settings: Settings
}): void {
  const llm = args.settings.llm ?? (args.settings.llm = {})
  const aliases = llm.aliases ?? (llm.aliases = {})
  for (const runtime of args.plugins.all()) {
    if (runtime.manifest.kind !== 'executor') continue
    const exec = runtime as unknown as {
      defaultAliases?: () => Record<string, { provider: string; model: string }>
    }
    if (typeof exec.defaultAliases !== 'function') continue
    for (const [k, v] of Object.entries(exec.defaultAliases())) {
      if (!aliases[k]) aliases[k] = v
    }
  }
  const planEnv = process.env['CLAUDE_PLANNING_MODEL']
  if (planEnv) aliases['planning'] = { provider: 'anthropic', model: planEnv }
  const codeEnv = process.env['CLAUDE_CODING_MODEL']
  if (codeEnv) aliases['coding'] = { provider: 'anthropic', model: codeEnv }
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
    llm: {
      defaultProvider: config.llm?.defaultProvider ?? 'anthropic',
      providers: {},
      aliases: { ...(config.llm?.aliases ?? {}) },
    },
    intake: {
      toolsEnabled: config.intake?.toolsEnabled !== false,
    },
  }
}
