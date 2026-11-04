import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Logger } from 'pino'
import type { LocalConfig } from '../config/local-config'
import {
  persistFreshInstallDefaultsIfNeeded,
  resolvePluginsConfig,
  resolveTenantOverlaySource,
} from '../config/local-config'
import { buildSettingsFromLocal, seedExecutorDefaultAliases } from './build-settings'
import { SqliteStateBackend } from '../state/sqlite-backend'
import type { EventTransport } from '../state/transport'
import { synthesizeSoloTenant } from '../intelligence/tenant-context'
import { Dispatcher } from '../jobs/dispatcher'
import type { RunnerContext } from '../jobs/runner'
import { createBitBucketClients } from '../clients/bitbucket'
import { createGitClient } from '../clients/git'
import { createGitHubClient } from '../clients/github'
import { createLokiClient } from '../clients/loki'
import { createTempoClient } from '../clients/tempo'
import { createDecisionClient } from '../clients/decision'
import { buildBuiltinPluginRegistry } from '../plugins/builtin'
import type { PluginRegistry } from '../plugins/registry'
import type { Settings } from '../config/settings'

export interface RunnerCore {
  effectiveConfig: LocalConfig
  settings: Settings
  stateBackend: SqliteStateBackend
  plugins: PluginRegistry
  runnerCtx: RunnerContext
  dispatcher: Dispatcher
  transport?: EventTransport
}

/**
 * Process core shared by `coro start` and `coro review run --once`.
 * The HTTP server is not started here. `--once` passes a temp database
 * and no transport.
 */
export async function createRunnerCore(opts: {
  config: LocalConfig | null
  logger: Logger
  dbPath: string
  attachTransport?: (deps: {
    stateBackend: SqliteStateBackend
    plugins: PluginRegistry
    logger: Logger
  }) => Promise<EventTransport | undefined>
}): Promise<RunnerCore> {
  const seeded = seedExecutorEnvCredentials(opts.config)
  const effectiveConfig = persistFreshInstallDefaultsIfNeeded(seeded)
  const settings = buildSettingsFromLocal(effectiveConfig)
  fs.mkdirSync(settings.paths.workingDir, { recursive: true })
  fs.mkdirSync(settings.paths.coroIntelligenceDir, { recursive: true })
  fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true })

  const stateBackend = new SqliteStateBackend(
    opts.dbPath,
    settings.paths.coroIntelligenceDir,
    opts.logger,
    settings.paths.baseLayerDir,
  )
  await stateBackend.initialize()

  const { coder: bbCoder, reviewer: bbReviewer } = createBitBucketClients(settings)
  const plugins = await buildBuiltinPluginRegistry({
    pluginsConfig: resolvePluginsConfig(effectiveConfig),
    settings,
    logger: opts.logger,
  })
  await seedExecutorDefaultAliases({ plugins, settings })

  const transport = await opts.attachTransport?.({ stateBackend, plugins, logger: opts.logger })
  const tenantContext = synthesizeSoloTenant({
    displayName: effectiveConfig.tenant?.displayName,
    overlay: resolveTenantOverlaySource(effectiveConfig),
  })
  const decisionClient = await createDecisionClient(settings)
  const runnerCtx: RunnerContext = {
    stateBackend,
    settings,
    tenantContext,
    gitClient: createGitClient(),
    bbCoder,
    bbReviewer,
    ghClient: createGitHubClient(settings),
    lokiClient: createLokiClient(settings),
    tempoClient: createTempoClient(settings),
    decisionClient,
    plugins,
    logger: opts.logger,
  }
  const dispatcher = new Dispatcher(runnerCtx, transport)
  await dispatcher.rateLimitScheduler.bootstrap().catch(err => {
    opts.logger.warn({ err }, 'RateLimitScheduler bootstrap failed')
  })
  return { effectiveConfig, settings, stateBackend, plugins, runnerCtx, dispatcher, ...(transport ? { transport } : {}) }
}

/**
 * Fill executor credentials from the environment when the config slot is
 * empty. The first provider that has credentials becomes the default when
 * the operator has not chosen one. Anthropic keeps its previous env names;
 * OpenAI uses `OPENAI_API_KEY`.
 */
export function seedExecutorEnvCredentials(config: LocalConfig | null): LocalConfig {
  const base: LocalConfig = config ?? { plugins: { installed: {} } }
  const installed = { ...(base.plugins?.installed ?? {}) }
  const anthropicEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY
  const openaiEnv = process.env.OPENAI_API_KEY
  if (!installed.anthropic && (anthropicEnv || (!config && !openaiEnv))) {
    const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
    installed.anthropic = {
      enabled: true,
      config: oauth
        ? { method: 'oauth', oauthToken: oauth }
        : { method: 'apiKey', apiKey: process.env.ANTHROPIC_API_KEY ?? '' },
    }
  }
  if (!installed.openai && openaiEnv) {
    installed.openai = { enabled: true, config: { apiKey: openaiEnv } }
  }
  const llm = { ...(base.llm ?? {}) }
  if (!llm.defaultProvider) {
    if (installed.anthropic && (anthropicEnv || !installed.openai)) llm.defaultProvider = 'anthropic'
    else if (installed.openai) llm.defaultProvider = 'openai'
  }
  return {
    ...base,
    plugins: { ...(base.plugins ?? {}), installed },
    ...(Object.keys(llm).length > 0 ? { llm } : {}),
  }
}

export function tempReviewDbPath(): string {
  return path.join(os.tmpdir(), `coro-review-${process.pid}-${Date.now()}.db`)
}
