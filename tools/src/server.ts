import crypto from 'crypto'
import express, { Express, Request, Response, NextFunction } from 'express'
import swaggerUi from 'swagger-ui-express'
import { Logger } from 'pino'
import { Dispatcher } from './jobs/dispatcher'
import { JobRegistry } from './jobs/registry'
import { JobType, MigrationJobInput, FeatureJobInput, JiraJobInput } from './jobs/types'
import { Settings } from './config/settings'
import { openApiSpec } from './openapi'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ServerContext {
  registry: JobRegistry
  dispatcher: Dispatcher
  settings: Settings
  logger: Logger
}

// ── HMAC verification ─────────────────────────────────────────────────────────

/**
 * Verifies a BitBucket webhook HMAC-SHA256 signature.
 *
 * CRITICAL: This must operate on the raw request body bytes — not a parsed
 * JSON object. Even whitespace differences will cause a signature mismatch.
 * The `/webhook` route uses express.raw() for exactly this reason.
 *
 * BitBucket sends the signature in the `X-Hub-Signature` header as:
 *   sha256=<hex-digest>
 */
function verifyHmac(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader) return false

  const hmac = crypto.createHmac('sha256', secret)
  hmac.update(rawBody)
  const expected = `sha256=${hmac.digest('hex')}`

  try {
    // Use timingSafeEqual to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(signatureHeader),
      Buffer.from(expected)
    )
  } catch {
    // Buffers were different lengths — signature is invalid
    return false
  }
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

function sseWrite(res: Response, data: string): void {
  res.write(`data: ${data}\n\n`)
}

function sseHeartbeat(res: Response): void {
  res.write(': heartbeat\n\n')
}

// ── Server factory ────────────────────────────────────────────────────────────

export function createServer(ctx: ServerContext): Express {
  const { registry, dispatcher, settings, logger } = ctx
  const app = express()

  // ── Global middleware ──────────────────────────────────────────────────────
  // NOTE: express.json() is applied globally EXCEPT on /webhook, which needs
  // the raw body for HMAC verification. We mount raw parsing on /webhook first,
  // then apply json parsing to everything else.

  // Raw body parser scoped to /webhook — must be registered before express.json()
  app.use('/webhook', express.raw({ type: 'application/json' }))

  // JSON parser for all other routes
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/webhook') return next()
    express.json()(req, res, next)
  })

  // Request logger
  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug({ method: req.method, path: req.path }, 'Incoming request')
    next()
  })

  // ── Health ─────────────────────────────────────────────────────────────────

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', version: '0.1.0' })
  })

  // ── OpenAPI / Swagger UI ───────────────────────────────────────────────────

  app.get('/openapi.json', (_req: Request, res: Response) => {
    res.json(openApiSpec)
  })

  // swagger-ui-express v5: serve handles static assets, setup handles the HTML page.
  // Splitting them across app.use/app.get ensures both /docs and /docs/ work.
  app.use('/docs', swaggerUi.serve)
  app.get('/docs', swaggerUi.setup(openApiSpec))

  // ── POST /jobs/migrate ─────────────────────────────────────────────────────

  app.post('/jobs/migrate', async (req: Request, res: Response) => {
    const { repo, projects, reviewers, stagingUrl, serviceName } = req.body as Partial<MigrationJobInput>

    if (!repo || !projects || !reviewers || !stagingUrl || !serviceName) {
      res.status(400).json({
        error: 'Missing required fields: repo, projects, reviewers, stagingUrl, serviceName',
      })
      return
    }

    if (!Array.isArray(projects) || projects.length === 0) {
      res.status(400).json({ error: 'projects must be a non-empty array' })
      return
    }

    if (!Array.isArray(reviewers) || reviewers.length === 0) {
      res.status(400).json({ error: 'reviewers must be a non-empty array' })
      return
    }

    const input: MigrationJobInput = {
      type: 'migration',
      repo,
      projects,
      reviewers,
      stagingUrl,
      serviceName,
    }

    const job = await dispatcher.dispatch(input)
    logger.info({ jobId: job.id, repo, serviceName }, 'Migration job dispatched')

    res.status(201).json({
      jobId: job.id,
      type: job.type,
      status: job.status,
      streamUrl: `/jobs/${job.id}/stream`,
    })
  })

  // ── POST /jobs/feature ─────────────────────────────────────────────────────

  app.post('/jobs/feature', async (req: Request, res: Response) => {
    const body = req.body as Partial<FeatureJobInput & JiraJobInput>

    // Jira-triggered: only jiraTicketId is required
    if ('jiraTicketId' in body && body.jiraTicketId) {
      const input: JiraJobInput = {
        type: 'feature',
        jiraTicketId: body.jiraTicketId,
        triggerSource: 'jira',
      }
      const job = await dispatcher.dispatch(input)
      logger.info({ jobId: job.id, jiraTicketId: body.jiraTicketId }, 'Feature job dispatched (Jira)')

      res.status(201).json({
        jobId: job.id,
        type: job.type,
        status: job.status,
        streamUrl: `/jobs/${job.id}/stream`,
      })
      return
    }

    // CLI-triggered: repo, reviewers, description, serviceName required
    const { repo, reviewers, description, serviceName } = body
    if (!repo || !reviewers || !description || !serviceName) {
      res.status(400).json({
        error: 'Missing required fields: repo, reviewers, description, serviceName (or provide jiraTicketId)',
      })
      return
    }

    if (!Array.isArray(reviewers) || reviewers.length === 0) {
      res.status(400).json({ error: 'reviewers must be a non-empty array' })
      return
    }

    const input: FeatureJobInput = {
      type: 'feature',
      repo,
      reviewers,
      description,
      serviceName,
    }

    const job = await dispatcher.dispatch(input)
    logger.info({ jobId: job.id, repo, serviceName }, 'Feature job dispatched (CLI)')

    res.status(201).json({
      jobId: job.id,
      type: job.type,
      status: job.status,
      streamUrl: `/jobs/${job.id}/stream`,
    })
  })

  // ── GET /jobs ──────────────────────────────────────────────────────────────

  app.get('/jobs', async (req: Request, res: Response) => {
    const typeFilter = req.query['type'] as string | undefined

    let jobs
    if (typeFilter && Object.values(JobType).includes(typeFilter as JobType)) {
      jobs = await registry.listJobsByType(typeFilter as JobType)
    } else {
      jobs = await registry.listJobs()
    }

    // Strip conversation history from list view — it can be large
    const summary = jobs.map(j => ({
      id: j.id,
      type: j.type,
      serviceName: j.serviceName,
      status: j.status,
      phase: j.phase,
      currentFeature: j.currentFeature,
      triggerSource: j.triggerSource,
      prCount: j.prMappings.length,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
    }))

    res.json({ jobs: summary, count: summary.length })
  })

  // ── GET /jobs/:jobId ───────────────────────────────────────────────────────

  app.get('/jobs/:jobId', async (req: Request, res: Response) => {
    const job = await registry.getJob(req.params['jobId'] as string)
    if (!job) {
      res.status(404).json({ error: `Job not found: ${req.params['jobId']}` })
      return
    }

    // Return full job but omit conversation history (use /stream for log output)
    const { conversationHistory: _conv, _signals, ...safe } = job
    void _conv
    void _signals
    res.json(safe)
  })

  // ── GET /jobs/:jobId/stream ────────────────────────────────────────────────
  // Server-Sent Events — streams log lines to the CLI in real time.
  // The CLI connects here and receives one `data:` event per log line.

  app.get('/jobs/:jobId/stream', async (req: Request, res: Response) => {
    const jobId = req.params['jobId'] as string
    const job = await registry.getJob(jobId)

    if (!job) {
      res.status(404).json({ error: `Job not found: ${jobId}` })
      return
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')  // disable nginx buffering
    res.flushHeaders()

    let cursor = 0

    // Send any existing log lines immediately
    const existing = await registry.getLog(jobId)
    for (const line of existing) {
      sseWrite(res, line)
    }
    cursor = existing.length

    // Poll for new log lines every 500ms
    const pollInterval = setInterval(async () => {
      try {
        const newLines = await registry.getLog(jobId, cursor, -1)
        for (const line of newLines) {
          sseWrite(res, line)
        }
        cursor += newLines.length

        // Check if job has reached a terminal state — if so, close the stream
        const current = await registry.getJob(jobId)
        if (!current) {
          clearInterval(pollInterval)
          res.end()
          return
        }
      } catch (err) {
        logger.error({ err, jobId }, 'SSE poll error')
      }
    }, 500)

    // Heartbeat every 15 seconds to keep the connection alive through proxies
    const heartbeatInterval = setInterval(() => {
      sseHeartbeat(res)
    }, 15_000)

    // Clean up when the client disconnects
    req.on('close', () => {
      clearInterval(pollInterval)
      clearInterval(heartbeatInterval)
      logger.debug({ jobId }, 'SSE client disconnected')
    })
  })

  // ── POST /jobs/:jobId/resume ───────────────────────────────────────────────
  // Stub — wired to the dispatcher in Phase 6.

  app.post('/jobs/:jobId/resume', async (req: Request, res: Response) => {
    const job = await registry.getJob(req.params['jobId'] as string)
    if (!job) {
      res.status(404).json({ error: `Job not found: ${req.params['jobId']}` })
      return
    }

    // Phase 6: dispatcher.resumeJob(job) will be called here
    res.status(501).json({
      error: 'Resume not yet implemented — available in Phase 6',
      jobId: job.id,
      status: job.status,
    })
  })

  // ── POST /webhook ──────────────────────────────────────────────────────────
  // Receives BitBucket webhook events.
  //
  // IMPORTANT: This route uses express.raw() (registered at the top of this
  // file) so `req.body` is a Buffer, not a parsed object. HMAC verification
  // must happen before JSON.parse().

  app.post('/webhook', (req: Request, res: Response) => {
    const rawBody = req.body as Buffer

    // 1. Verify HMAC signature
    const signature = req.headers['x-hub-signature'] as string | undefined
    if (!verifyHmac(rawBody, signature, settings.host.webhookSecret)) {
      logger.warn({ signature }, 'Webhook HMAC verification failed')
      res.status(401).json({ error: 'Invalid signature' })
      return
    }

    // 2. Parse event
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(rawBody.toString('utf-8')) as Record<string, unknown>
    } catch {
      res.status(400).json({ error: 'Invalid JSON payload' })
      return
    }

    // 3. Detect event source and type
    const bbEventKey = req.headers['x-event-key'] as string | undefined
    const atlassianToken = req.headers['x-atlassian-token'] as string | undefined

    if (bbEventKey) {
      logger.info({ eventKey: bbEventKey }, 'BitBucket webhook received')
      void dispatcher.handleWebhookEvent('bitbucket', bbEventKey, payload)
      res.json({ received: true, source: 'bitbucket', eventKey: bbEventKey })
      return
    }

    if (atlassianToken !== undefined) {
      logger.info({ payload }, 'Jira webhook received')
      void dispatcher.handleWebhookEvent('jira', 'jira:event', payload)
      res.json({ received: true, source: 'jira' })
      return
    }

    logger.warn({ headers: req.headers }, 'Webhook from unknown source')
    res.status(400).json({ error: 'Unknown webhook source' })
  })

  // ── 404 fallthrough ────────────────────────────────────────────────────────

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' })
  })

  // ── Error handler ──────────────────────────────────────────────────────────

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'Unhandled server error')
    res.status(500).json({ error: 'Internal server error' })
  })

  return app
}
