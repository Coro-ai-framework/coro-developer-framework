// ── Hybrid Runner Entry Point ─────────────────────────────────────────────────
//
// Standalone process that runs agent jobs locally while delegating state to the
// cloud control plane via WebSocket (hybrid mode) or storing state locally in
// SQLite (local mode). Falls back to legacy monolith when REDIS_URL is present.
//
// Usage:
//   a5 runner start                     # reads ~/.a5/config.json
//   a5 runner start --config ./my.json  # custom config path
//
// The runner:
//   1. Reads local config to determine deployment mode
//   2. Creates the appropriate StateBackend + EventTransport
//   3. Builds a RunnerContext with local filesystem access + API clients
//   4. Connects to cloud (hybrid) or opens a local dashboard server (local)
//   5. Waits for job dispatch commands from the CLI or cloud

import 'dotenv/config'
import pino from 'pino'
import fs from 'fs'
import {
  loadLocalConfig,
  detectMode,
  resolveIntelligenceDir,
  resolveWorkingDir as resolveLocalWorkingDir,
  type LocalConfig,
} from '../config/local-config'
import { Settings } from '../config/settings'
import { CloudStateBackend } from '../state/cloud-backend'
import { WebSocketTransport } from '../state/ws-transport'
import { SqliteStateBackend } from '../state/sqlite-backend'
import { PollingTransport } from '../state/polling-transport'
import { Dispatcher } from '../jobs/dispatcher'
import type { RunnerContext } from '../jobs/runner'
import { createBitBucketClients } from '../clients/bitbucket'
import { createGitClient, createGitHubGitClient } from '../clients/git'
import { createGitHubClient } from '../clients/github'
import { createJiraClient } from '../clients/jira'
import { createLokiClient } from '../clients/loki'
import { createTempoClient } from '../clients/tempo'
import { wireCloudJobDispatch } from './hybrid-dispatcher'
import { createRunnerServer } from './server'

export interface RunnerOptions {
  configPath?: string
  port?: number
}

// ── Build Settings from LocalConfig ──────────────────────────────────────────

/**
 * Build a Settings object from LocalConfig. In hybrid mode, not all legacy
 * settings are needed — the runner only uses Anthropic API key, git credentials,
 * intelligence dir, and working dir. Cloud state replaces Redis.
 */
function buildSettingsFromLocal(config: LocalConfig): Settings {
  const intelligenceDir = resolveIntelligenceDir(config)
  const workingDir = resolveLocalWorkingDir(config)

  return {
    host: {
      port: 0,             // Not used in hybrid mode — no local HTTP server for the monolith
      webhookSecret: '',    // Webhooks handled by cloud
      logLevel: process.env.LOG_LEVEL ?? 'info',
    },
    claude: {
      apiKey: config.anthropic.apiKey,
      planningModel: process.env.CLAUDE_PLANNING_MODEL ?? 'claude-opus-4-6',
      codingModel: process.env.CLAUDE_CODING_MODEL ?? 'claude-sonnet-4-6',
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
      url: '',  // Not used in hybrid mode
    },
    paths: {
      workingDir,
      a5aiDir: intelligenceDir,
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
      baseUrl: process.env.JIRA_BASE_URL ?? '',
      username: process.env.JIRA_USERNAME ?? '',
      apiToken: process.env.JIRA_API_TOKEN ?? '',
      pollIntervalSeconds: 60,
    },
    ngrok: {
      authToken: '',
      staticDomain: '',
    },
  }
}

// ── Local Mode Bootstrap (SQLite + Polling) ──────────────────────────────────

export async function startLocalRunner(
  config: LocalConfig | null,
  logger: pino.Logger,
  localPort: number,
): Promise<{ dispatcher: Dispatcher; shutdown: () => Promise<void> }> {
  const effectiveConfig: LocalConfig = config ?? { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY ?? '' } }
  const settings = buildSettingsFromLocal(effectiveConfig)

  // Ensure working + intelligence dirs exist
  fs.mkdirSync(settings.paths.workingDir, { recursive: true })
  fs.mkdirSync(settings.paths.a5aiDir, { recursive: true })

  // Create SQLite state backend — DB lives next to config in ~/.a5/
  const path = await import('path')
  const os = await import('os')
  const configDir = path.join(os.homedir(), '.a5')
  const dbPath = path.join(configDir, 'state.db')
  fs.mkdirSync(configDir, { recursive: true })

  logger.info({ dbPath }, 'Opening SQLite database')
  const stateBackend = new SqliteStateBackend(dbPath, settings.paths.a5aiDir, logger)
  await stateBackend.initialize()

  // Build external API clients (run locally on dev machine)
  const { coder: bbCoder, reviewer: bbReviewer } = createBitBucketClients(settings)
  const gitClient = createGitClient(settings)
  const ghClient = createGitHubClient(settings)
  const ghGitClient = createGitHubGitClient(settings)
  const lokiClient = createLokiClient(settings)
  const tempoClient = createTempoClient(settings)
  const jiraClient = createJiraClient(settings)

  // Determine which PR poller to use based on git provider
  const gitProvider = effectiveConfig.git?.provider ?? 'github'
  const prPoller = gitProvider === 'bitbucket'
    ? bbCoder
    : (ghClient ?? bbCoder)  // Fall back to bbCoder if GitHub not configured

  // Create polling transport for PR event detection
  const transport = new PollingTransport({
    stateBackend,
    prPoller,
    defaultRepoSlug: '',
    intervalMs: 60_000,
    logger,
  })
  await transport.connect()

  // Build runner context
  const runnerCtx: RunnerContext = {
    stateBackend,
    settings,
    gitClient,
    bbCoder,
    bbReviewer,
    ghClient,
    ghGitClient,
    lokiClient,
    tempoClient,
    jiraClient,
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
  fs.mkdirSync(settings.paths.a5aiDir, { recursive: true })

  // Create WebSocket transport to cloud
  const transport = new WebSocketTransport({
    url: config.cloud.url.replace(/^http/, 'ws') + '/ws/runner',
    token: config.cloud.token,
    logger,
  })

  // Connect to cloud
  logger.info({ url: config.cloud.url }, 'Connecting to cloud control plane...')
  await transport.connect()
  logger.info('Connected to cloud control plane')

  // Extract team ID from the runner token (JWT payload)
  const teamId = extractTeamIdFromToken(config.cloud.token)

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

  // Build runner context
  const runnerCtx: RunnerContext = {
    stateBackend,
    settings,
    gitClient,
    bbCoder,
    bbReviewer,
    ghClient,
    ghGitClient,
    lokiClient,
    tempoClient,
    jiraClient,
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
  logger.info('  A5 Labs Runner  v0.1.0')
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
      ;(globalThis as Record<string, unknown>).__a5_dispatcher = dispatcher

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
        // No config at all — create minimal config to get started
        logger.info('No config found — using defaults for local mode')
        logger.info('Run `a5 init --local` to customise settings')
      }

      const localPort = options.port ?? 3000
      const { dispatcher, shutdown } = await startLocalRunner(config, logger, localPort)

      logger.info('Local runner ready — waiting for job commands')
      logger.info(`Dashboard: http://localhost:${localPort}/dashboard/`)

      // Expose dispatcher for CLI job dispatch
      ;(globalThis as Record<string, unknown>).__a5_dispatcher = dispatcher

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

    case 'legacy': {
      // Legacy mode: redirect to the existing monolith entry point
      logger.info('Legacy mode detected — starting monolith agent host')
      logger.info('To switch to hybrid mode, run: a5 login && a5 init')
      // Dynamically import to avoid loading all monolith dependencies
      await import('../index')
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
