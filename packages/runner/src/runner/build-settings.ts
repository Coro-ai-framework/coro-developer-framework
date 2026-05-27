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
 */
export function buildSettingsFromLocal(config: LocalConfig): Settings {
  const intelligenceDir = resolveIntelligenceDir(config)
  const workingDir = resolveLocalWorkingDir(config)

  return {
    host: {
      port: 0,
      webhookSecret: '',
      logLevel: process.env.LOG_LEVEL ?? 'info',
    },
    bitbucket: {
      workspace: config.git?.workspace ?? process.env.BITBUCKET_WORKSPACE ?? '',
      baseUrl: process.env.BITBUCKET_BASE_URL ?? 'https://api.bitbucket.org/2.0',
      coderAccount: {
        username: config.git?.username ?? '',
        appPassword: config.git?.token ?? '',
      },
      reviewerAccount: {
        username: process.env.BITBUCKET_REVIEWER_USERNAME ?? config.git?.username ?? '',
        appPassword: process.env.BITBUCKET_REVIEWER_APP_PASSWORD ?? config.git?.token ?? '',
      },
    },
    github: {
      owner: config.git?.workspace ?? process.env.GITHUB_OWNER ?? '',
      token: config.git?.provider === 'github'
        ? (config.git?.token ?? process.env.GITHUB_TOKEN ?? '')
        : (process.env.GITHUB_TOKEN ?? ''),
      baseUrl: process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com',
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
    jira: {
      baseUrl: config.tracker?.jira?.baseUrl ?? process.env.JIRA_BASE_URL ?? '',
      username: config.tracker?.jira?.username ?? process.env.JIRA_USERNAME ?? '',
      apiToken: config.tracker?.jira?.apiToken ?? process.env.JIRA_API_TOKEN ?? '',
      pollIntervalSeconds: 60,
    },
    ...(config.tracker?.provider
      ? { tracker: { provider: config.tracker.provider } }
      : {}),
    ...(config.tracker?.linear?.apiKey
      ? {
          linear: {
            apiKey: config.tracker.linear.apiKey,
            ...(config.tracker.linear.teamKey ? { teamKey: config.tracker.linear.teamKey } : {}),
          },
        }
      : {}),
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
