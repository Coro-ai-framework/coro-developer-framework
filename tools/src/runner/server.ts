// ── Runner Local HTTP Server ──────────────────────────────────────────────────
//
// A lightweight Express server that runs on the developer's machine when the
// runner is in hybrid mode. This provides a REST API for CLI commands to
// dispatch jobs, check status, and stream logs — same interface as the legacy
// monolith but backed by the cloud StateBackend.

import express, { Request, Response } from 'express'
import http from 'http'
import path from 'path'
import { Logger } from 'pino'
import type { Dispatcher } from '../jobs/dispatcher'
import type { StateBackend } from '../state/backend'

export interface RunnerServerOptions {
  port: number
  dispatcher: Dispatcher
  stateBackend: StateBackend
  logger: Logger
}

/**
 * Create and start the runner's local HTTP server.
 * CLI commands (`a5 migrate`, `a5 status`, etc.) talk to this.
 */
export function createRunnerServer(opts: RunnerServerOptions): http.Server {
  const { port, dispatcher, stateBackend, logger } = opts
  const app = express()
  app.use(express.json())

  // ── Health ──────────────────────────────────────────────────────────────

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', mode: 'hybrid', version: '0.1.0' })
  })

  // ── Job dispatch ────────────────────────────────────────────────────────

  app.post('/jobs/migrate', async (req: Request, res: Response) => {
    try {
      const { repo, projects, reviewers, stagingUrl, serviceName } = req.body ?? {}
      if (!repo) { res.status(400).json({ error: 'repo is required' }); return }

      const job = await dispatcher.dispatch({
        type: 'migration',
        params: { repo, projects, reviewers, stagingUrl, serviceName },
      })
      res.status(201).json({
        jobId: job.id,
        type: job.type,
        status: job.status,
        streamUrl: `/jobs/${job.id}/stream`,
      })
    } catch (err) {
      logger.error({ err }, 'Migration dispatch failed')
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.post('/jobs/feature', async (req: Request, res: Response) => {
    try {
      const { repo, description, reviewers, jiraTicket } = req.body ?? {}
      if (!repo) { res.status(400).json({ error: 'repo is required' }); return }

      const job = await dispatcher.dispatch({
        type: 'feature',
        params: { repo, description, reviewers, jiraTicket },
      })
      res.status(201).json({
        jobId: job.id,
        type: job.type,
        status: job.status,
        streamUrl: `/jobs/${job.id}/stream`,
      })
    } catch (err) {
      logger.error({ err }, 'Feature dispatch failed')
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // ── Job CRUD ────────────────────────────────────────────────────────────

  app.get('/jobs', async (_req: Request, res: Response) => {
    try {
      const jobs = await stateBackend.listJobs()
      res.json(jobs)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.get('/jobs/:jobId', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const job = await stateBackend.getJob(jobId)
      if (!job) { res.status(404).json({ error: 'Job not found' }); return }
      res.json(job)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // ── Log streaming (SSE) ─────────────────────────────────────────────────

  app.get('/jobs/:jobId/stream', async (req: Request, res: Response) => {
    const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
    const job = await stateBackend.getJob(jobId)

    if (!job) {
      res.status(404).json({ error: 'Job not found' })
      return
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    // Send existing logs first
    const existingLogs = await stateBackend.getLog(jobId)
    for (const line of existingLogs) {
      res.write(`data: ${line}\n\n`)
    }

    // Poll for new logs (simple polling — could be improved with pub/sub)
    let lastLen = existingLogs.length
    const interval = setInterval(async () => {
      try {
        const currentLen = await stateBackend.logLength(jobId)
        if (currentLen > lastLen) {
          const newLines = await stateBackend.getLog(jobId, lastLen)
          for (const line of newLines) {
            res.write(`data: ${line}\n\n`)
          }
          lastLen = currentLen
        }

        // Check if job is done
        const currentJob = await stateBackend.getJob(jobId)
        if (currentJob && (currentJob.status === 'complete' || currentJob.status === 'failed')) {
          res.write(`event: done\ndata: ${currentJob.status}\n\n`)
          clearInterval(interval)
          res.end()
        }
      } catch {
        // Ignore poll errors
      }
    }, 1000)

    req.on('close', () => {
      clearInterval(interval)
    })
  })

  // ── Resume ──────────────────────────────────────────────────────────────

  app.post('/jobs/:jobId/resume', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const { fromPhase, clearSession } = req.body ?? {}
      await dispatcher.resumeJob(jobId, fromPhase, clearSession)
      res.json({ resumed: jobId })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // ── Message injection ───────────────────────────────────────────────────

  app.post('/jobs/:jobId/message', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const { message } = req.body ?? {}
      if (!message) { res.status(400).json({ error: 'message is required' }); return }
      await dispatcher.sendMessage(jobId, message)
      res.json({ sent: true })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // ── Dashboard (local mode) ─────────────────────────────────────────────

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

  // ── Start server ────────────────────────────────────────────────────────

  const server = http.createServer(app)
  server.listen(port, () => {
    logger.info({ port }, 'Runner HTTP server listening')
  })

  return server
}
