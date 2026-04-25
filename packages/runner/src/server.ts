import crypto from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import express, { Express, Request, Response, NextFunction } from 'express'
import swaggerUi from 'swagger-ui-express'
import { Logger } from 'pino'
import { Dispatcher } from './jobs/dispatcher'
import type { StateBackend } from './state/backend'
import { Artifact, JobType, isStoppedStatus } from './jobs/types'
import { createJobInput, type CreateJobRequest } from './jobs/creation'
import { Settings } from './config/settings'
import { openApiSpec } from './openapi'
import { loadWorkflowConfig } from './workflow-parser'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ServerContext {
  stateBackend: StateBackend
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

// ── MIME inference for artefact content ──────────────────────────────────────

function inferMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.md':   return 'text/markdown; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.txt':  return 'text/plain; charset=utf-8'
    case '.html': return 'text/html; charset=utf-8'
    case '.yml':
    case '.yaml': return 'text/yaml; charset=utf-8'
    default:      return 'text/plain; charset=utf-8'
  }
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

function sseWrite(res: Response, data: string): void {
  const encoded = data.split('\n').map(line => `data: ${line}`).join('\n')
  res.write(`${encoded}\n\n`)
}

function sseHeartbeat(res: Response): void {
  res.write(': heartbeat\n\n')
}

// ── Server factory ────────────────────────────────────────────────────────────

export function createServer(ctx: ServerContext): Express {
  const { stateBackend, dispatcher, settings, logger } = ctx
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
    res.json({ status: 'ok', version: '0.2.0' })
  })

  // ── OpenAPI / Swagger UI ───────────────────────────────────────────────────

  app.get('/openapi.json', (_req: Request, res: Response) => {
    res.json(openApiSpec)
  })

  // swagger-ui-express v5: serve handles static assets, setup handles the HTML page.
  // Splitting them across app.use/app.get ensures both /docs and /docs/ work.
  app.use('/docs', swaggerUi.serve)
  app.get('/docs', swaggerUi.setup(openApiSpec))

  // ── POST /jobs ─────────────────────────────────────────────────────────────

  app.post('/jobs', async (req: Request, res: Response) => {
    try {
      const body = req.body as Partial<CreateJobRequest>
      if (typeof body?.workflowPath !== 'string' || !body.workflowPath.trim()) {
        res.status(400).json({ error: 'workflowPath is required' })
        return
      }

      const input = createJobInput(body as CreateJobRequest)
      const job = await dispatcher.dispatch(input)

      logger.info({ jobId: job.id, workflowPath: job.workflowPath }, 'Job dispatched')

      res.status(201).json({
        jobId: job.id,
        type: job.type,
        status: job.status,
        streamUrl: `/jobs/${job.id}/stream`,
      })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // ── GET /jobs ──────────────────────────────────────────────────────────────

  app.get('/jobs', async (req: Request, res: Response) => {
    const typeFilter = req.query['type'] as string | undefined

    let jobs
    if (typeFilter && Object.values(JobType).includes(typeFilter as JobType)) {
      jobs = await stateBackend.listJobsByType(typeFilter as JobType)
    } else {
      jobs = await stateBackend.listJobs()
    }

    // Strip conversation history from list view — it can be large
    const summary = jobs.map(j => ({
      id: j.id,
      type: j.type,
      serviceName: j.params['serviceName'] ?? null,
      status: j.status,
      phase: j.phase,
      currentWorkItem: j.currentWorkItem,
      triggerSource: j.triggerSource,
      interactive: j.interactive ?? false,
      artifactCount: (j.artifacts ?? []).length,
      prCount: j.prMappings.length,
      totalCostUsd: j.tokenUsage?.totalCostUsd ?? null,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
    }))

    res.json({ jobs: summary, count: summary.length })
  })

  // ── GET /jobs/:jobId ───────────────────────────────────────────────────────

  app.get('/jobs/:jobId', async (req: Request, res: Response) => {
    const job = await stateBackend.getJob(req.params['jobId'] as string)
    if (!job) {
      res.status(404).json({ error: `Job not found: ${req.params['jobId']}` })
      return
    }

    // Attach the parsed workflow phases so the dashboard can render a flowchart
    // without a second round-trip. The MD parse is cheap and happens on demand.
    let workflowPhases: Array<{ name: string; status: string; interactiveCheckpoint?: boolean }> | null = null
    if (job.workflowPath) {
      try {
        const config = await loadWorkflowConfig(job.workflowPath, settings.paths.coroIntelligenceDir, logger)
        if (config) {
          workflowPhases = config.phases.map(p => ({
            name: p.name,
            status: p.status,
            ...(p.interactiveCheckpoint ? { interactiveCheckpoint: true } : {}),
          }))
        }
      } catch (err) {
        logger.warn({ err, jobId: job.id }, 'Could not load workflow config for job detail response')
      }
    }

    res.json({ ...job, workflowPhases })
  })

  // ── GET /jobs/:jobId/artifacts/:artifactId/content ─────────────────────────
  // Read-only endpoint that returns the content of an artefact whose `data.path`
  // is a file inside the job working directory. Used by the dashboard to render
  // plan-md, report-md, and other file-based artefacts in a modal.
  //
  // Security: the resolved path MUST stay inside {workingDir}/{jobId}/.

  app.get('/jobs/:jobId/artifacts/:artifactId/content', async (req: Request, res: Response) => {
    const jobId = req.params['jobId'] as string
    const artifactId = req.params['artifactId'] as string

    const job = await stateBackend.getJob(jobId)
    if (!job) {
      res.status(404).json({ error: `Job not found: ${jobId}` })
      return
    }

    const artifact: Artifact | undefined = (job.artifacts ?? []).find(a => a.id === artifactId)
    if (!artifact) {
      res.status(404).json({ error: `Artifact not found: ${artifactId}` })
      return
    }

    const rawPath = artifact.data?.['path']
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      res.status(400).json({ error: 'Artifact has no `data.path` to read' })
      return
    }

    // Resolve relative to the job's working directory and reject anything that
    // escapes it (via .., absolute paths pointing elsewhere, symlinks, etc.).
    const jobWorkingDir = path.resolve(settings.paths.workingDir, jobId)
    const resolved = path.resolve(jobWorkingDir, rawPath)
    if (!resolved.startsWith(jobWorkingDir + path.sep) && resolved !== jobWorkingDir) {
      logger.warn({ jobId, artifactId, rawPath, resolved }, 'Artifact path escape attempt blocked')
      res.status(400).json({ error: 'Artifact path is outside the job working directory' })
      return
    }

    try {
      const content = await fs.readFile(resolved, 'utf-8')
      const mime = inferMimeType(resolved)
      res.setHeader('Content-Type', mime)
      res.send(content)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      res.status(404).json({ error: `Could not read artifact content: ${msg}` })
    }
  })

  // ── GET /jobs/:jobId/stream ────────────────────────────────────────────────
  // Server-Sent Events — streams log lines to the CLI in real time.
  // The CLI connects here and receives one `data:` event per log line.

  app.get('/jobs/:jobId/stream', async (req: Request, res: Response) => {
    const jobId = req.params['jobId'] as string
    const job = await stateBackend.getJob(jobId)

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
    const existing = await stateBackend.getLog(jobId)
    for (const line of existing) {
      sseWrite(res, line)
    }
    cursor = existing.length

    // Poll for new log lines every 500ms
    const pollInterval = setInterval(async () => {
      try {
        const newLines = await stateBackend.getLog(jobId, cursor, -1)
        for (const line of newLines) {
          sseWrite(res, line)
        }
        cursor += newLines.length

        // Close the stream when the job finishes (complete / failed / escalated)
        const current = await stateBackend.getJob(jobId)
        if (!current) {
          clearInterval(pollInterval)
          clearInterval(heartbeatInterval)
          res.end()
          return
        }
        if (isStoppedStatus(current.status)) {
          clearInterval(pollInterval)
          clearInterval(heartbeatInterval)
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
    const jobId = req.params['jobId'] as string
    const job = await stateBackend.getJob(jobId)
    if (!job) {
      res.status(404).json({ error: `Job not found: ${jobId}` })
      return
    }

    const body = req.body as Record<string, unknown>
    const fromPhase = body['fromPhase'] as string | undefined
    const clearSession = body['clearSession'] === true

    try {
      await dispatcher.resumeJob(jobId, fromPhase, clearSession)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      res.status(409).json({ error: msg, jobId, status: job.status })
      return
    }

    res.json({ jobId, status: 'resuming', phase: fromPhase ?? job.phase, clearSession, streamUrl: `/jobs/${jobId}/stream` })
  })

  // ── POST /jobs/:jobId/message ──────────────────────────────────────────────
  // Send a developer message to a running agent. The dispatcher injects it
  // into the active SDK Query via streamInput().

  app.post('/jobs/:jobId/message', async (req: Request, res: Response) => {
    const jobId = req.params['jobId'] as string
    const body = req.body as Record<string, unknown>
    const message = body['message']

    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message is required (non-empty string)' })
      return
    }

    try {
      await dispatcher.sendMessage(jobId, message.trim())
      res.json({ sent: true, jobId })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      res.status(409).json({ error: msg, jobId })
    }
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

  // ── Dashboard (production) ──────────────────────────────────────────────────
  // In production, serve the built Vite dashboard as static files.
  // In development, use `npm run dev` in dashboard/ with its Vite proxy instead.

  const dashboardDir = path.join(__dirname, '../../dashboard/dist')
  app.use(express.static(dashboardDir))
  app.get('*', (req: Request, res: Response) => {
    if (req.accepts('html')) {
      res.sendFile(path.join(dashboardDir, 'index.html'), err => {
        if (err) res.status(404).json({ error: 'Not found' })
      })
      return
    }
    res.status(404).json({ error: 'Not found' })
  })

  // ── Error handler ──────────────────────────────────────────────────────────

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'Unhandled server error')
    res.status(500).json({ error: 'Internal server error' })
  })

  return app
}
