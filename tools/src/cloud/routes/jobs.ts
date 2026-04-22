import { Router, Request, Response } from 'express'
import type { CloudDb } from '../db/connection'
import type { CloudConfig } from '../config'
import type { WsGateway } from '../ws/gateway'
import { PostgresStateBackend } from '../db/postgres-backend'
import { requireAuth, requireTeamMember } from '../auth/middleware'
import { JobInput, isStoppedStatus, ProposalStatus } from '../../jobs/types'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract a route param safely (Express v5 types params as string | string[]) */
function p(req: Request, name: string): string {
  const v = req.params[name]
  return Array.isArray(v) ? v[0] : v
}

function backendFor(db: CloudDb, teamId: string): PostgresStateBackend {
  return new PostgresStateBackend(db, teamId)
}

// ── Job routes ────────────────────────────────────────────────────────────────

export function jobRoutes(db: CloudDb, config: CloudConfig, gateway?: WsGateway): Router {
  const router = Router({ mergeParams: true })
  const auth = requireAuth(config)
  const member = requireTeamMember()

  // ── Create job ────────────────────────────────────────────────────────────

  router.post('/', auth, member, async (req: Request, res: Response) => {
    const teamId = p(req, 'teamId')
    const backend = backendFor(db, teamId)
    const input: JobInput = req.body

    if (!input?.type || !input?.params) {
      res.status(400).json({ error: 'type and params are required' })
      return
    }

    const job = await backend.createJob(input)

    // Dispatch to a connected runner via WebSocket
    if (gateway) {
      const dispatched = gateway.sendToTeam(teamId, {
        type: 'event:dispatch',
        jobId: job.id,
      })
      if (!dispatched) {
        res.status(201).json({ ...job, warning: 'No runner connected — job queued' })
        return
      }
    }

    res.status(201).json(job)
  })

  // ── List jobs ─────────────────────────────────────────────────────────────

  router.get('/', auth, member, async (req: Request, res: Response) => {
    const backend = backendFor(db, p(req, 'teamId'))
    const jobs = await backend.listJobs()
    res.json(jobs)
  })

  // ── Get job ───────────────────────────────────────────────────────────────

  router.get('/:jobId', auth, member, async (req: Request, res: Response) => {
    const backend = backendFor(db, p(req, 'teamId'))
    const job = await backend.getJob(p(req, 'jobId'))

    if (!job) {
      res.status(404).json({ error: 'Job not found' })
      return
    }

    res.json(job)
  })

  // ── Update job ────────────────────────────────────────────────────────────

  router.patch('/:jobId', auth, member, async (req: Request, res: Response) => {
    const backend = backendFor(db, p(req, 'teamId'))

    try {
      const job = await backend.updateJob(p(req, 'jobId'), req.body)
      res.json(job)
    } catch (err) {
      res.status(404).json({ error: (err as Error).message })
    }
  })

  // ── Delete job ────────────────────────────────────────────────────────────

  router.delete('/:jobId', auth, member, async (req: Request, res: Response) => {
    const backend = backendFor(db, p(req, 'teamId'))
    await backend.deleteJob(p(req, 'jobId'))
    res.status(204).end()
  })

  // ── Dispatch job to runner ────────────────────────────────────────────────

  router.post('/:jobId/dispatch', auth, member, async (req: Request, res: Response) => {
    const teamId = p(req, 'teamId')
    const jobId = p(req, 'jobId')

    if (!gateway) {
      res.status(503).json({ error: 'WebSocket gateway not available' })
      return
    }

    const dispatched = gateway.sendToTeam(teamId, {
      type: 'event:dispatch',
      jobId,
    })

    if (!dispatched) {
      res.status(503).json({ error: 'No runner connected for this team' })
      return
    }

    res.json({ dispatched: true, jobId })
  })

  // ── Resume job on runner ──────────────────────────────────────────────────

  router.post('/:jobId/resume', auth, member, async (req: Request, res: Response) => {
    const teamId = p(req, 'teamId')
    const jobId = p(req, 'jobId')
    const { prompt } = req.body ?? {}

    if (!gateway) {
      res.status(503).json({ error: 'WebSocket gateway not available' })
      return
    }

    const sent = gateway.sendToTeam(teamId, {
      type: 'event:resume',
      jobId,
      prompt,
    })

    if (!sent) {
      res.status(503).json({ error: 'No runner connected for this team' })
      return
    }

    res.json({ resumed: true, jobId })
  })

  // ── Append log ────────────────────────────────────────────────────────────

  router.post('/:jobId/logs', auth, member, async (req: Request, res: Response) => {
    const backend = backendFor(db, p(req, 'teamId'))
    const { lines } = req.body ?? {}

    if (!Array.isArray(lines)) {
      res.status(400).json({ error: 'lines array is required' })
      return
    }

    for (const line of lines) {
      await backend.appendLog(p(req, 'jobId'), line)
    }

    res.status(204).end()
  })

  // ── SSE log stream ────────────────────────────────────────────────────────

  router.get('/:jobId/stream', auth, member, async (req: Request, res: Response) => {
    const backend = backendFor(db, p(req, 'teamId'))

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    let cursor = 0
    const interval = setInterval(async () => {
      try {
        const lines = await backend.getLog(p(req, 'jobId'), cursor)
        for (const line of lines) {
          res.write(`data: ${JSON.stringify({ type: 'log', line })}\n\n`)
          cursor++
        }

        const job = await backend.getJob(p(req, 'jobId'))
        if (job && isStoppedStatus(job.status)) {
          res.write(`data: ${JSON.stringify({ type: 'status', status: job.status })}\n\n`)
          clearInterval(interval)
          res.end()
        }
      } catch {
        clearInterval(interval)
        res.end()
      }
    }, 1000)

    // Heartbeat
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n')
    }, 15000)

    req.on('close', () => {
      clearInterval(interval)
      clearInterval(heartbeat)
    })
  })

  return router
}

// ── Proposal routes ─────────────────────────────────────────────────────────

export function proposalRoutes(db: CloudDb, config: CloudConfig, gateway?: WsGateway): Router {
  const router = Router({ mergeParams: true })
  const auth = requireAuth(config)
  const member = requireTeamMember()

  // ── List proposals ────────────────────────────────────────────────────────

  router.get('/', auth, member, async (req: Request, res: Response) => {
    const backend = backendFor(db, p(req, 'teamId'))
    const status = req.query.status as ProposalStatus | undefined
    const proposals = await backend.listProposals(p(req, 'teamId'), status)
    res.json(proposals)
  })

  // ── Get proposal ──────────────────────────────────────────────────────────

  router.get('/:proposalId', auth, member, async (req: Request, res: Response) => {
    const backend = backendFor(db, p(req, 'teamId'))
    const proposal = await backend.getProposal(p(req, 'teamId'), p(req, 'proposalId'))

    if (!proposal) {
      res.status(404).json({ error: 'Proposal not found' })
      return
    }

    res.json(proposal)
  })

  // ── Approve proposal ──────────────────────────────────────────────────────

  router.post('/:proposalId/approve', auth, member, async (req: Request, res: Response) => {
    const teamId = p(req, 'teamId')
    const backend = backendFor(db, teamId)
    const { note } = req.body ?? {}

    try {
      const proposal = await backend.updateProposal(
        teamId,
        p(req, 'proposalId'),
        {
          status: 'approved',
          reviewedBy: req.user!.sub,
          reviewNote: note,
        },
      )

      // Send proposal:apply command to runner via WebSocket
      if (gateway && proposal) {
        gateway.sendToTeam(teamId, {
          type: 'proposal:apply',
          proposalId: p(req, 'proposalId'),
          files: (proposal as unknown as Record<string, unknown>).files as Array<{ path: string; content: string }> ?? [],
        })
      }

      res.json(proposal)
    } catch (err) {
      res.status(404).json({ error: (err as Error).message })
    }
  })

  // ── Reject proposal ───────────────────────────────────────────────────────

  router.post('/:proposalId/reject', auth, member, async (req: Request, res: Response) => {
    const backend = backendFor(db, p(req, 'teamId'))
    const { note } = req.body ?? {}

    try {
      const proposal = await backend.updateProposal(
        p(req, 'teamId'),
        p(req, 'proposalId'),
        {
          status: 'rejected',
          reviewedBy: req.user!.sub,
          reviewNote: note,
        },
      )
      res.json(proposal)
    } catch (err) {
      res.status(404).json({ error: (err as Error).message })
    }
  })

  // ── Update proposal (edit before approval) ────────────────────────────────

  router.patch('/:proposalId', auth, member, async (req: Request, res: Response) => {
    const backend = backendFor(db, p(req, 'teamId'))

    try {
      const proposal = await backend.updateProposal(
        p(req, 'teamId'),
        p(req, 'proposalId'),
        req.body,
      )
      res.json(proposal)
    } catch (err) {
      res.status(404).json({ error: (err as Error).message })
    }
  })

  return router
}
