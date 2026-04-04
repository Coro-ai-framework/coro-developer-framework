import 'dotenv/config'  // loads .env if present; no-op in Docker where env vars are injected
import { loadSettings } from './config/settings'
import Redis from 'ioredis'
import pino from 'pino'
import { JobRegistry } from './jobs/registry'
import { createServer } from './server'

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
    // Retry connection up to 10 times with exponential backoff
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

  // Wait for first successful connection before starting the server
  await redis.ping()
  logger.info('Redis ping OK')

  // 4. Create registry and start HTTP server
  const registry = new JobRegistry(redis)
  const app = createServer({ registry, settings, logger })

  const server = app.listen(settings.host.port, () => {
    logger.info({ port: settings.host.port }, 'HTTP server listening')
    logger.info('─────────────────────────────────────────')
    logger.info('  Agent Host is ready')
    logger.info('─────────────────────────────────────────')
  })

  // 5. Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutdown signal received')
    server.close(() => logger.info('HTTP server closed'))
    await redis.quit()
    logger.info('Redis disconnected')
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  // pino may not be initialized yet if settings.ts throws, so fall back to console
  console.error('Fatal error during startup:', err)
  process.exit(1)
})
