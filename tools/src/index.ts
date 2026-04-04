import 'dotenv/config'  // loads .env if present; no-op in Docker where env vars are injected
import Anthropic from '@anthropic-ai/sdk'
import Redis from 'ioredis'
import pino from 'pino'
import { loadSettings } from './config/settings'
import { createBitBucketClients } from './clients/bitbucket'
import { createGitClient } from './clients/git'
import { createJiraClient } from './clients/jira'
import { createLokiClient } from './clients/loki'
import { createTempoClient } from './clients/tempo'
import { Dispatcher } from './jobs/dispatcher'
import { JobRegistry } from './jobs/registry'
import { RunnerContext } from './jobs/runner'
import { createServer } from './server'
import { startWatcher } from './watcher'

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. Load and validate settings (throws on missing required fields)
  const settings = loadSettings()

  // 2. Set up structured logger
  const logger = pino({
    level: settings.host.logLevel,
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  })

  logger.info('─────────────────────────────────────────')
  logger.info('  A5 Labs Agent Host  v0.1.0')
  logger.info('─────────────────────────────────────────')
  logger.info({ port: settings.host.port, logLevel: settings.host.logLevel }, 'Configuration loaded')
  logger.info({ model: settings.claude.planningModel }, 'Planning model')
  logger.info({ model: settings.claude.codingModel }, 'Coding model')
  logger.info({ workspace: settings.bitbucket.workspace }, 'BitBucket workspace')
  logger.info({ url: settings.redis.url }, 'Connecting to Redis')

  // 3. Connect to Redis
  const redis = new Redis(settings.redis.url, {
    retryStrategy: (times) => {
      if (times > 10) {
        logger.error('Redis connection failed after 10 retries — exiting')
        process.exit(1)
      }
      const delay = Math.min(times * 200, 2000)
      logger.warn({ attempt: times, delayMs: delay }, 'Redis reconnecting')
      return delay
    },
    lazyConnect: false,
  })

  redis.on('connect', () => logger.info('Redis connected'))
  redis.on('error', (err: Error) => logger.error({ err }, 'Redis error'))

  await redis.ping()
  logger.info('Redis ping OK')

  // 4. Create registry and external clients
  const registry = new JobRegistry(redis, settings.paths.a5aiDir, logger)
  const { coder: bbCoder, reviewer: bbReviewer } = createBitBucketClients(settings)
  const gitClient = createGitClient(settings)
  const lokiClient = createLokiClient(settings)
  const tempoClient = createTempoClient(settings)
  const jiraClient = createJiraClient(settings)
  const anthropic = new Anthropic({ apiKey: settings.claude.apiKey })

  logger.info('All clients initialised')

  // 5. Build the runner context shared across all jobs
  const runnerCtx: RunnerContext = {
    registry,
    settings,
    gitClient,
    bbCoder,
    bbReviewer,
    lokiClient,
    tempoClient,
    jiraClient,
    anthropic,
    logger,
  }

  // 6. Create dispatcher (owns the runner loop and concurrency guard)
  const dispatcher = new Dispatcher(runnerCtx)

  // 7. Start file watcher (self-improvement loop)
  const watcher = startWatcher({ settings, gitClient, bbCoder, registry, logger })

  // 8. Start HTTP server
  const app = createServer({ registry, dispatcher, settings, logger })

  const server = app.listen(settings.host.port, () => {
    logger.info({ port: settings.host.port }, 'HTTP server listening')
    logger.info('─────────────────────────────────────────')
    logger.info('  Agent Host is ready')
    logger.info(`  Docs: http://localhost:${settings.host.port}/docs`)
    logger.info('─────────────────────────────────────────')
  })

  // 8. Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutdown signal received')
    server.close(() => logger.info('HTTP server closed'))
    await watcher.close()
    logger.info('File watcher stopped')
    await redis.quit()
    logger.info('Redis disconnected')
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  console.error('Fatal error during startup:', err)
  process.exit(1)
})
