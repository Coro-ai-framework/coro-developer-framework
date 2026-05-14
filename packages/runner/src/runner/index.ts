// ── Coro Runner Entry Point ───────────────────────────────────────────────────
//
// Standalone process that runs agent jobs locally and either:
//   • delegates state to the cloud control plane via WebSocket (hybrid mode), or
//   • keeps state locally in SQLite (local mode, the default for solo developers).
//
// Usage:
//   coro start                     # reads ~/.coro/config.json
//   coro start --config ./my.json  # custom config path
//
// The runner:
//   1. Reads local config to determine deployment mode
//   2. Creates the appropriate StateBackend + EventTransport
//   3. Builds a RunnerContext with local filesystem access + API clients
//   4. Connects to cloud (hybrid) or opens a local dashboard server (local)
//   5. Waits for job dispatch commands from the CLI or cloud

import 'dotenv/config'

// ── Enable SDK parent-side debug logging BEFORE the SDK is imported ───────
//
// The Claude Agent SDK has a parent-side debug logger (`L6` in the
// bundled sdk.mjs) that emits lines like
//     [Query.connectSdkMcpServer] Failed to connect MCP server 'coro': …
//     [Query.sendMcpServerMessageToCli] Transport write failed: …
// These are the definitive signal for in-process MCP registration
// failures. By default they are dropped entirely unless:
//
//   1. `DEBUG_SDK=1` (or `DEBUG`) is in the parent process env — enables
//      the logger at all. The SDK memoises this check on first import,
//      so we MUST set it before any `import` statement executes.
//   2. `--debug-to-stderr` is in `process.argv` — redirects logger output
//      from a rotating file (~/.claude/debug/<pid>.txt) to stderr, which
//      is what our monkey-patch below can see. Without this flag L6
//      writes to that file and we'd have to tail it separately.
//
// The stderr monkey-patch tees any line that mentions MCP/sdk-server
// concerns into stdout tagged `[sdk-parent-stderr] …` so it shows up
// in the runner's pino-pretty output next to our normal logs.
if (!process.env.DEBUG_SDK && !process.env.DEBUG) {
  process.env.DEBUG_SDK = '1'
}
if (!process.argv.includes('--debug-to-stderr') && !process.argv.includes('-d2e')) {
  process.argv.push('--debug-to-stderr')
}

{
  const origWrite = process.stderr.write.bind(process.stderr) as typeof process.stderr.write
  const interestingRx = /(Query\.connectSdkMcpServer|Query\.sendMcpServerMessageToCli|mcp_set_servers|mcp_message|sdkMcpServer|Transport write failed|Failed to connect MCP)/i
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    try {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8')
      if (interestingRx.test(text)) {
        process.stdout.write(`[sdk-parent-stderr] ${text.trim()}\n`)
      }
    } catch { /* never break stderr */ }
    return origWrite(chunk as string, ...(rest as [BufferEncoding?, ((err?: Error | null) => void)?]))
  }) as typeof process.stderr.write
}

import pino from 'pino'
import fs from 'fs'
import {
  loadLocalConfig,
  detectMode,
  resolveIntelligenceDir,
  resolveProposalsConfig,
  resolvePluginsConfig,
  resolveTenantOverlaySource,
  resolveWorkingDir as resolveLocalWorkingDir,
  type LocalConfig,
} from '../config/local-config'
import { buildBuiltinPluginRegistry } from '../plugins/builtin'
import { makePluginWebhookNormalizer } from '../plugins/webhook-bridge'
import { createAnthropicExecutor, type ClaudeAuthConfig } from '@coro/llm-anthropic'
import type { PluginRegistry } from '../plugins/registry'
import type { PluginsConfig } from '../config/plugins-config'
import { getBaseLayerRoot } from '@coro/intelligence-base'

import { Settings } from '../config/settings'
import { CloudStateBackend } from '../state/cloud-backend'
import { WebSocketTransport } from '../state/ws-transport'
import { SqliteStateBackend } from '../state/sqlite-backend'
import { PollingTransport } from '../state/polling-transport'
import { synthesizeSoloTenant, tenantFromTeamId } from '../intelligence/tenant-context'
import { Dispatcher } from '../jobs/dispatcher'
import type { RunnerContext } from '../jobs/runner'
import { createBitBucketClients } from '../clients/bitbucket'
import { createGitClient, createGitHubGitClient } from '../clients/git'
import { createGitHubClient } from '../clients/github'
import { createJiraClient } from '../clients/jira'
import { createLokiClient } from '../clients/loki'
import { createTempoClient } from '../clients/tempo'
import { createTrackerClient } from '../clients/tracker'
import { wireCloudJobDispatch } from './hybrid-dispatcher'
import { createRunnerServer } from './server'

export interface RunnerOptions {
  configPath?: string
  port?: number
}

// ── Build Settings from LocalConfig ──────────────────────────────────────────

/**
 * Register the built-in Anthropic phase executor on the plugin registry.
 *
 * The executor's auth config flows through the standard plugin path:
 * `pluginsConfig.installed.anthropic.config` is forwarded verbatim to
 * the constructor (as `auth` seed) and to `init()`, mirroring how every
 * future LLM plugin will be loaded once the built-in registration
 * helper is retired.
 *
 * Idempotent: returns immediately when an `anthropic` plugin is already
 * registered (lets external plugin overrides win without a startup
 * crash on the duplicate-id guard).
 */
async function registerAnthropicExecutor(args: {
  plugins: PluginRegistry
  settings: Settings
  pluginsConfig: PluginsConfig
  logger: pino.Logger
}): Promise<void> {
  if (args.plugins.byId('anthropic')) {
    args.logger.info('Anthropic executor already registered (override) — skipping built-in registration')
    return
  }
  // Pull the persisted plugin config (auth method + credentials) out
  // of the resolved PluginsConfig. Empty config is acceptable here —
  // healthcheck surfaces the missing-cred case rather than crashing
  // the runner at boot.
  const installed = args.pluginsConfig.installed?.['anthropic']
  const cfg = (installed?.config ?? {}) as Record<string, unknown>
  const auth: ClaudeAuthConfig = {
    method: (cfg['method'] as ClaudeAuthConfig['method']) ?? 'apiKey',
    ...(typeof cfg['apiKey'] === 'string' ? { apiKey: cfg['apiKey'] as string } : {}),
    ...(typeof cfg['oauthToken'] === 'string' ? { oauthToken: cfg['oauthToken'] as string } : {}),
    ...(cfg['account'] ? { account: cfg['account'] as ClaudeAuthConfig['account'] } : {}),
  }
  const executor = createAnthropicExecutor({ settings: args.settings, auth, logger: args.logger })
  await executor.init(cfg, { logger: args.logger, fetch: globalThis.fetch })
  args.plugins.register(executor)
  // Mark Anthropic as the default executor so phase resolution that
  // doesn't name a `provider:` falls back to it. Mirrors the
  // synth in `buildSettingsFromLocal` (`llm.defaultProvider`).
  args.plugins.setDefaults({
    ...args.plugins.getDefaults(),
    executor: args.settings.llm?.defaultProvider ?? 'anthropic',
  })
}

/**
 * Seed `settings.llm.aliases` from each executor plugin's
 * {@link PhaseExecutorRuntime.defaultAliases}. Operator-supplied
 * aliases (loaded from `LocalConfig` in a future phase) win over
 * plugin defaults. Env var overrides (`CLAUDE_PLANNING_MODEL` /
 * `CLAUDE_CODING_MODEL`) trump everything for back-compat with the
 * pre-Phase-C bootstrap behaviour.
 */
function seedExecutorDefaultAliases(args: { plugins: PluginRegistry; settings: Settings }): void {
  const llm = args.settings.llm ?? (args.settings.llm = {})
  const aliases = llm.aliases ?? (llm.aliases = {})
  for (const runtime of args.plugins.all()) {
    if (runtime.manifest.kind !== 'executor') continue
    const exec = runtime as unknown as { defaultAliases?: () => Record<string, { provider: string; model: string }> }
    if (typeof exec.defaultAliases !== 'function') continue
    for (const [k, v] of Object.entries(exec.defaultAliases())) {
      if (!aliases[k]) aliases[k] = v
    }
  }
  // Legacy env overrides — Anthropic-pinned for back-compat. Future
  // env knobs will land under provider-neutral names (LLM_*).
  const planEnv = process.env['CLAUDE_PLANNING_MODEL']
  if (planEnv) aliases['planning'] = { provider: 'anthropic', model: planEnv }
  const codeEnv = process.env['CLAUDE_CODING_MODEL']
  if (codeEnv) aliases['coding'] = { provider: 'anthropic', model: codeEnv }
}

/**
 * Build the in-memory `Settings` object that the runner hands to its API
 * clients (BitBucket, GitHub, Loki, …) and the job runner. We synthesise it
 * from `LocalConfig`; legacy disk-based settings.json loading was removed
 * along with the Redis monolith.
 */
function buildSettingsFromLocal(config: LocalConfig): Settings {
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
      url: '',  // Reserved for future cloud-worker use; unused in local + hybrid modes.
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
      // Local config wins so the dashboard's Tracker section is the
      // single source of truth; env vars stay as a no-config fallback
      // for headless deployments that drove the runner before the
      // dashboard existed.
      baseUrl: config.tracker?.jira?.baseUrl ?? process.env.JIRA_BASE_URL ?? '',
      username: config.tracker?.jira?.username ?? process.env.JIRA_USERNAME ?? '',
      apiToken: config.tracker?.jira?.apiToken ?? process.env.JIRA_API_TOKEN ?? '',
      pollIntervalSeconds: 60,
    },
    // The campaign workflow consults `tracker.provider` to pick a client.
    // When the user leaves the dashboard field unset we infer from
    // available credentials at the factory layer, so saving a partial
    // config never crashes the runner.
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
    // Multi-provider LLM configuration. Aliases are seeded post-bootstrap
    // by {@link seedExecutorDefaultAliases} from each executor plugin's
    // `defaultAliases()`, so the runner stays provider-agnostic — every
    // canonical alias originates in a plugin, not the runner.
    llm: {
      defaultProvider: 'anthropic',
      providers: {},
      aliases: {},
    },
  }
}

// ── Local Mode Bootstrap (SQLite + Polling) ──────────────────────────────────

export async function startLocalRunner(
  config: LocalConfig | null,
  logger: pino.Logger,
  localPort: number,
): Promise<{ dispatcher: Dispatcher; shutdown: () => Promise<void> }> {
  // Fallback when no config.json exists: honour either Anthropic env var so
  // developers can bootstrap local mode with just `ANTHROPIC_API_KEY=... coro runner start`.
  const envOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
  const envApiKey = process.env.ANTHROPIC_API_KEY
  const effectiveConfig: LocalConfig = config ?? {
    anthropic: envOauth
      ? { method: 'oauth', oauthToken: envOauth }
      : { method: 'apiKey', apiKey: envApiKey ?? '' },
  }
  const settings = buildSettingsFromLocal(effectiveConfig)

  // Ensure working + intelligence dirs exist
  fs.mkdirSync(settings.paths.workingDir, { recursive: true })
  fs.mkdirSync(settings.paths.coroIntelligenceDir, { recursive: true })

  // Create SQLite state backend — DB lives next to config in ~/.coro/
  const path = await import('path')
  const os = await import('os')
  const configDir = path.join(os.homedir(), '.coro')
  const dbPath = path.join(configDir, 'state.db')
  fs.mkdirSync(configDir, { recursive: true })

  logger.info({ dbPath }, 'Opening SQLite database')
  const stateBackend = new SqliteStateBackend(
    dbPath,
    settings.paths.coroIntelligenceDir,
    logger,
    settings.paths.baseLayerDir,
  )
  await stateBackend.initialize()

  // Build external API clients (run locally on dev machine)
  const { coder: bbCoder, reviewer: bbReviewer } = createBitBucketClients(settings)
  const gitClient = createGitClient(settings)
  const ghClient = createGitHubClient(settings)
  const ghGitClient = createGitHubGitClient(settings)
  const lokiClient = createLokiClient(settings)
  const tempoClient = createTempoClient(settings)
  const jiraClient = createJiraClient(settings)
  const trackerClient = createTrackerClient(settings)

  // Build the plugin registry from the resolved PluginsConfig (legacy
  // config blocks still supported via `legacyConfigToPlugins`). The
  // registry is the new home for SCM/Tracker resolution; the legacy
  // client fields above stay populated for back-compat MCP wrappers.
  const pluginsConfig = resolvePluginsConfig(effectiveConfig)
  const plugins = await buildBuiltinPluginRegistry({ pluginsConfig, logger })
  await registerAnthropicExecutor({ plugins, settings, pluginsConfig, logger })
  seedExecutorDefaultAliases({ plugins, settings })

  // Create polling transport for PR event detection. Plugin-aware
  // polling lives in the SCM plugins themselves (`pollPr`); the
  // transport delegates to whichever SCM plugin owns each parked
  // job's external_ref.
  const transport = new PollingTransport({
    stateBackend,
    plugins,
    intervalMs: 60_000,
    logger,
  })
  await transport.connect()

  // Local mode = solo developer on their own machine. Synthesize a stable
  // `solo-<host>` tenant so per-job state and overlays are scoped consistently.
  // Phase 4: forward the optional `tenant.overlay` from local config so a
  // single-host solo deployment can still pull a tenant-level overlay
  // (typically `localDir` or `gitRemote`).
  const tenantContext = synthesizeSoloTenant({
    displayName: effectiveConfig.tenant?.displayName,
    overlay: resolveTenantOverlaySource(effectiveConfig),
  })
  logger.info(
    {
      tenantId: tenantContext.tenantId,
      mode: tenantContext.mode,
      overlayKind: tenantContext.overlay.kind,
    },
    'Tenant context',
  )

  // Build runner context
  const runnerCtx: RunnerContext = {
    stateBackend,
    settings,
    tenantContext,
    gitClient,
    bbCoder,
    bbReviewer,
    ghClient,
    ghGitClient,
    lokiClient,
    tempoClient,
    jiraClient,
    trackerClient,
    plugins,
    logger,
  }

  // Create dispatcher with polling transport for event delivery
  const dispatcher = new Dispatcher(runnerCtx, transport)

  // Start local HTTP server (same as hybrid but serves dashboard too)
  const server = createRunnerServer({
    port: localPort,
    dispatcher,
    stateBackend,
    logger,
    mode: 'local',
    tenantId: tenantContext.tenantId,
    plugins,
  })

  const shutdown = async () => {
    logger.info('Shutting down local runner...')
    server.close()
    await transport.disconnect()
    stateBackend.close()
  }

  return { dispatcher, shutdown }
}

// ── Hybrid Mode Bootstrap ────────────────────────────────────────────────────

export async function startHybridRunner(
  config: LocalConfig,
  logger: pino.Logger,
  localPort: number,
): Promise<{ dispatcher: Dispatcher; transport: WebSocketTransport; shutdown: () => Promise<void> }> {
  if (!config.cloud?.url || !config.cloud?.token) {
    throw new Error('Hybrid mode requires cloud.url and cloud.token in config')
  }

  const settings = buildSettingsFromLocal(config)

  // Ensure working + intelligence dirs exist
  fs.mkdirSync(settings.paths.workingDir, { recursive: true })
  fs.mkdirSync(settings.paths.coroIntelligenceDir, { recursive: true })

  // Build the plugin registry up front so we can supply the WS
  // transport with a closure that normalises plugin webhooks.
  const pluginsConfig = resolvePluginsConfig(config)
  const plugins = await buildBuiltinPluginRegistry({ pluginsConfig, logger })
  await registerAnthropicExecutor({ plugins, settings, pluginsConfig, logger })
  seedExecutorDefaultAliases({ plugins, settings })

  // Create WebSocket transport to cloud
  const transport = new WebSocketTransport({
    url: config.cloud.url.replace(/^http/, 'ws') + '/ws/runner',
    token: config.cloud.token,
    logger,
    normalizePluginWebhook: makePluginWebhookNormalizer({ plugins, logger }),
  })

  // Connect to cloud
  logger.info({ url: config.cloud.url }, 'Connecting to cloud control plane...')
  await transport.connect()
  logger.info('Connected to cloud control plane')

  // Extract team ID from the runner token (JWT payload)
  const teamId = extractTeamIdFromToken(config.cloud.token)

  // Hybrid mode = the runner acts on behalf of a team. The tenant ID is
  // derived from the JWT-issued teamId so every job dispatched here is
  // correctly scoped to that team.
  //
  // Phase 4 leaves the cloud-supplied overlay descriptor `undefined` —
  // the WebSocket handshake doesn't carry per-tenant overlays yet.
  // Phase 5 will populate this from a `tenant.overlay` field returned by
  // `wireCloudJobDispatch`'s initial `runner_hello` response.
  const tenantContext = tenantFromTeamId(teamId, {
    displayName: config.tenant?.displayName,
    overlay: resolveTenantOverlaySource(config),
  })
  logger.info(
    {
      tenantId: tenantContext.tenantId,
      mode: tenantContext.mode,
      overlayKind: tenantContext.overlay.kind,
      teamId,
    },
    'Tenant context',
  )

  // Create CloudStateBackend that routes state ops over WebSocket
  const stateBackend = new CloudStateBackend(transport, teamId)

  // Build external API clients (run locally on dev machine)
  const { coder: bbCoder, reviewer: bbReviewer } = createBitBucketClients(settings)
  const gitClient = createGitClient(settings)
  const ghClient = createGitHubClient(settings)
  const ghGitClient = createGitHubGitClient(settings)
  const lokiClient = createLokiClient(settings)
  const tempoClient = createTempoClient(settings)
  const jiraClient = createJiraClient(settings)
  const trackerClient = createTrackerClient(settings)

  // Build runner context — `plugins` was created above so the WS
  // transport could capture the webhook normaliser closure before
  // connecting.
  const runnerCtx: RunnerContext = {
    stateBackend,
    settings,
    tenantContext,
    gitClient,
    bbCoder,
    bbReviewer,
    ghClient,
    ghGitClient,
    lokiClient,
    tempoClient,
    jiraClient,
    trackerClient,
    plugins,
    logger,
  }

  // Create dispatcher with WebSocket transport for event delivery
  const dispatcher = new Dispatcher(runnerCtx, transport)

  // Wire cloud-initiated job dispatch and proposal apply
  wireCloudJobDispatch(dispatcher, transport, runnerCtx)

  // Start local HTTP server for CLI commands
  const server = createRunnerServer({
    port: localPort,
    dispatcher,
    stateBackend,
    logger,
    mode: 'hybrid',
    tenantId: tenantContext.tenantId,
    plugins,
  })

  const shutdown = async () => {
    logger.info('Shutting down hybrid runner...')
    server.close()
    await transport.disconnect()
  }

  return { dispatcher, transport, shutdown }
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function startRunner(options: RunnerOptions = {}): Promise<void> {
  const config = loadLocalConfig(options.configPath)
  const mode = detectMode(config)

  const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  })

  logger.info('─────────────────────────────────────────')
  logger.info('  Coro Runner  v0.1.0')
  logger.info(`  Mode: ${mode}`)
  logger.info('─────────────────────────────────────────')

  switch (mode) {
    case 'hybrid': {
      if (!config) throw new Error('No config found for hybrid mode')
      const localPort = options.port ?? 3000

      const { dispatcher, shutdown } = await startHybridRunner(config, logger, localPort)

      logger.info('Hybrid runner ready — waiting for job commands')
      logger.info(`Working directory: ${resolveLocalWorkingDir(config)}`)
      logger.info(`Intelligence directory: ${resolveIntelligenceDir(config)}`)

      // Expose dispatcher for CLI job dispatch
      ;(globalThis as Record<string, unknown>).__coro_dispatcher = dispatcher

      // Graceful shutdown
      const handleShutdown = async () => {
        await shutdown()
        process.exit(0)
      }
      process.on('SIGINT', handleShutdown)
      process.on('SIGTERM', handleShutdown)

      // Keep process alive
      await new Promise(() => {})
      break
    }

    case 'local': {
      if (!config) {
        logger.info('No config found — using defaults for local mode')
        logger.info('Open the dashboard to configure Claude credentials and Git, or run `coro init --local`')
      }

      const localPort = options.port ?? 3000
      const { dispatcher, shutdown } = await startLocalRunner(config, logger, localPort)

      logger.info('Local runner ready — waiting for job commands')
      logger.info(`Dashboard: http://localhost:${localPort}/dashboard/`)

      // Expose dispatcher for CLI job dispatch
      ;(globalThis as Record<string, unknown>).__coro_dispatcher = dispatcher

      const handleShutdown = async () => {
        await shutdown()
        process.exit(0)
      }
      process.on('SIGINT', handleShutdown)
      process.on('SIGTERM', handleShutdown)

      // Keep process alive
      await new Promise(() => {})
      break
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract teamId from a runner JWT token without full verification.
 * The token has already been verified by the cloud on WebSocket connect.
 */
function extractTeamIdFromToken(token: string): string {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error('Invalid JWT')
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    if (!payload.teamId) throw new Error('No teamId in token payload')
    return payload.teamId
  } catch (err) {
    throw new Error(`Failed to extract teamId from runner token: ${err}`)
  }
}
