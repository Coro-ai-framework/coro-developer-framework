import 'dotenv/config'
import http from 'http'
import express from 'express'
import pino from 'pino'
import { loadCloudConfig } from './config'
import { createDb, closeDb } from './db/connection'
import { authRoutes } from './auth/routes'
import { teamRoutes } from './routes/teams'
import { jobRoutes, proposalRoutes } from './routes/jobs'
import { webhookRoutes } from './routes/webhooks'
import { RunnerRegistry } from './ws/runner-registry'
import { WsGateway } from './ws/gateway'

async function main(): Promise<void> {
  const config = loadCloudConfig()

  const logger = pino({
    level: config.logLevel,
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  })

  logger.info('─────────────────────────────────────────')
  logger.info('  Coro Cloud Control Plane  v0.1.0')
  logger.info('─────────────────────────────────────────')

  // Database
  const db = createDb(config.databaseUrl)
  logger.info('Connected to Postgres')

  // Runner registry + WebSocket gateway
  const registry = new RunnerRegistry(logger)
  const gateway = new WsGateway({ config, db, logger, registry })

  // Express app
  const app = express()
  app.use(express.json())

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '0.1.0' })
  })

  // Auth routes
  app.use('/auth', authRoutes(db, config))

  // Team routes
  app.use('/teams', teamRoutes(db, config))

  // Team-scoped job + proposal routes
  app.use('/teams/:teamId/jobs', jobRoutes(db, config, gateway))
  app.use('/teams/:teamId/proposals', proposalRoutes(db, config, gateway))

  // Webhook routes (per-team, HMAC-verified)
  app.use('/webhook', webhookRoutes({ db, gateway, logger }))

  // Runner status endpoint
  app.get('/teams/:teamId/runners', (req, res) => {
    const teamId = req.params.teamId
    const teamIdStr = Array.isArray(teamId) ? teamId[0] : teamId
    const runners = registry.getTeamRunnersPublic(teamIdStr)
    res.json(runners)
  })

  // Create HTTP server and attach WebSocket gateway
  const server = http.createServer(app)
  gateway.attach(server)

  server.listen(config.port, () => {
    logger.info({ port: config.port }, 'Cloud control plane listening (HTTP + WebSocket)')
  })

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...')
    gateway.close()
    server.close()
    await closeDb()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
