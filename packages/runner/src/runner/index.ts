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
  resolvePluginsConfig,
  resolveTenantOverlaySource,
  resolveWorkingDir as resolveLocalWorkingDir,
  persistFreshInstallDefaultsIfNeeded,
  type LocalConfig,
} from '../config/local-config'
import { buildBuiltinPluginRegistry } from '../plugins/builtin'
import { makePluginWebhookNormalizer } from '../plugins/webhook-bridge'

import { buildSettingsFromLocal, seedExecutorDefaultAliases } from './build-settings'
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
import { createLokiClient } from '../clients/loki'
import { createTempoClient } from '../clients/tempo'
import { wireCloudJobDispatch } from './hybrid-dispatcher'
import { createRunnerServer } from './server'

export interface RunnerOptions {
  configPath?: string
  port?: number
}

// ── Local Mode Bootstrap (SQLite + Polling) ──────────────────────────────────

export async function startLocalRunner(
  config: LocalConfig | null,
  logger: pino.Logger,
  localPort: number,
): Promise<{ dispatcher: Dispatcher; shutdown: () => Promise<void> }> {
  // Fallback when no config.json exists: honour either Anthropic env var so
  // developers can bootstrap local mode with just `ANTHROPIC_API_KEY=... coro runner start`.
  // We seed the modern plugin slot directly so the rest of the boot
  // path is identical regardless of where the credential came from.
  const envOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
  const envApiKey = process.env.ANTHROPIC_API_KEY
  const baseConfig: LocalConfig = config ?? {
    plugins: {
      installed: {
        anthropic: {
          enabled: true,
          config: envOauth
            ? { method: 'oauth', oauthToken: envOauth }
            : { method: 'apiKey', apiKey: envApiKey ?? '' },
        },
      },
    },
  }
  const effectiveConfig = persistFreshInstallDefaultsIfNeeded(baseConfig)
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

  // Build the plugin registry from the resolved PluginsConfig. The
  // registry is the single source of truth for every provider (LLM,
  // SCM, tracker) — every credential lives under
  // `plugins.installed.<id>.config`.
  const pluginsConfig = resolvePluginsConfig(effectiveConfig)
  const plugins = await buildBuiltinPluginRegistry({ pluginsConfig, settings, logger })
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
    plugins,
    logger,
  }

  // Create dispatcher with polling transport for event delivery
  const dispatcher = new Dispatcher(runnerCtx, transport)

  // Re-arm any rate-limit wake-ups that were pending when the runner
  // last shut down. Best-effort — logged but never fatal.
  await dispatcher.rateLimitScheduler.bootstrap().catch((err) => {
    logger.warn({ err }, 'RateLimitScheduler bootstrap failed')
  })

  // Start local HTTP server (same as hybrid but serves dashboard too).
  // We pass `runnerCtx` so the server can hot-reload its in-memory
  // copy of settings/clients/plugins after `PUT /config` instead of
  // forcing the operator to restart the runner.
  const server = createRunnerServer({
    port: localPort,
    dispatcher,
    stateBackend,
    logger,
    mode: 'local',
    tenantId: tenantContext.tenantId,
    plugins,
    runnerCtx,
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

  const effectiveConfig = persistFreshInstallDefaultsIfNeeded(config)
  const settings = buildSettingsFromLocal(effectiveConfig)
  const cloud = config.cloud

  // Ensure working + intelligence dirs exist
  fs.mkdirSync(settings.paths.workingDir, { recursive: true })
  fs.mkdirSync(settings.paths.coroIntelligenceDir, { recursive: true })

  // Build the plugin registry up front so we can supply the WS
  // transport with a closure that normalises plugin webhooks.
  const pluginsConfig = resolvePluginsConfig(effectiveConfig)
  const plugins = await buildBuiltinPluginRegistry({ pluginsConfig, settings, logger })
  seedExecutorDefaultAliases({ plugins, settings })

  // Create WebSocket transport to cloud
  const transport = new WebSocketTransport({
    url: cloud.url.replace(/^http/, 'ws') + '/ws/runner',
    token: cloud.token,
    logger,
    normalizePluginWebhook: makePluginWebhookNormalizer({ plugins, logger }),
  })

  // Connect to cloud
  logger.info({ url: cloud.url }, 'Connecting to cloud control plane...')
  await transport.connect()
  logger.info('Connected to cloud control plane')

  // Extract team ID from the runner token (JWT payload)
  const teamId = extractTeamIdFromToken(cloud.token)

  // Hybrid mode = the runner acts on behalf of a team. The tenant ID is
  // derived from the JWT-issued teamId so every job dispatched here is
  // correctly scoped to that team.
  //
  // Phase 4 leaves the cloud-supplied overlay descriptor `undefined` —
  // the WebSocket handshake doesn't carry per-tenant overlays yet.
  // Phase 5 will populate this from a `tenant.overlay` field returned by
  // `wireCloudJobDispatch`'s initial `runner_hello` response.
  const tenantContext = tenantFromTeamId(teamId, {
    displayName: effectiveConfig.tenant?.displayName,
    overlay: resolveTenantOverlaySource(effectiveConfig),
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
    plugins,
    logger,
  }

  // Create dispatcher with WebSocket transport for event delivery
  const dispatcher = new Dispatcher(runnerCtx, transport)

  // Re-arm any rate-limit wake-ups that were pending when the runner
  // last shut down. Best-effort — logged but never fatal.
  await dispatcher.rateLimitScheduler.bootstrap().catch((err) => {
    logger.warn({ err }, 'RateLimitScheduler bootstrap failed')
  })

  // Wire cloud-initiated job dispatch and proposal apply
  wireCloudJobDispatch(dispatcher, transport, runnerCtx)

  // Start local HTTP server for CLI commands. `runnerCtx` is forwarded
  // so dashboard config writes hot-reload in-memory state without a
  // runner restart.
  const server = createRunnerServer({
    port: localPort,
    dispatcher,
    stateBackend,
    logger,
    mode: 'hybrid',
    tenantId: tenantContext.tenantId,
    plugins,
    runnerCtx,
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
