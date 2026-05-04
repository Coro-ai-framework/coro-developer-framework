// ── WebSocket Gateway ─────────────────────────────────────────────────────────
//
// Handles the /ws/runner upgrade endpoint on the cloud control plane.
// Authenticates runners via JWT, registers them in the RunnerRegistry,
// and handles all runner→cloud RPC + event routing.

import { IncomingMessage } from 'http'
import { Server as HttpServer } from 'http'
import WebSocket, { WebSocketServer } from 'ws'
import { Logger } from 'pino'
import { URL } from 'url'
import { verifyToken, RunnerTokenPayload } from '../auth/jwt'
import type { CloudConfig } from '../config'
import type { CloudDb } from '../db/connection'
import { PostgresStateBackend } from '../db/postgres-backend'
import { RunnerRegistry } from './runner-registry'
import type {
  RunnerMessage,
  CloudMessage,
  WsRunnerRegister,
  WsRunnerHeartbeat,
} from '../../state/ws-protocol'

export interface GatewayContext {
  config: CloudConfig
  db: CloudDb
  logger: Logger
  registry: RunnerRegistry
}

export class WsGateway {
  private wss: WebSocketServer
  private ctx: GatewayContext

  constructor(ctx: GatewayContext) {
    this.ctx = ctx
    this.wss = new WebSocketServer({ noServer: true })
    this.wss.on('connection', (ws: WebSocket, _req: unknown, runner: RunnerTokenPayload) => this.handleConnection(ws, runner))
  }

  // ── Attach to HTTP server ──────────────────────────────────────────────────

  /**
   * Wire the upgrade handler onto the HTTP server. Only upgrades requests
   * to /ws/runner. All other upgrade requests are destroyed.
   */
  attach(server: HttpServer): void {
    server.on('upgrade', async (req, socket, head) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
        if (url.pathname !== '/ws/runner') {
          socket.destroy()
          return
        }

        const runner = await this.authenticate(req)
        if (!runner) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }

        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit('connection', ws, req, runner)
        })
      } catch (err) {
        this.ctx.logger.error({ err }, 'WebSocket upgrade error')
        socket.destroy()
      }
    })

    this.ctx.registry.start()
    this.ctx.logger.info('WebSocket gateway attached')
  }

  /** Shut down the WebSocket server and registry. */
  close(): void {
    this.ctx.registry.stop()
    for (const client of this.wss.clients) {
      client.close(1001, 'server shutting down')
    }
    this.wss.close()
  }

  // ── Authentication ─────────────────────────────────────────────────────────

  private async authenticate(req: IncomingMessage): Promise<RunnerTokenPayload | null> {
    // Token from query param: /ws/runner?token=...
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    let token = url.searchParams.get('token')

    // Or from Authorization header
    if (!token) {
      const auth = req.headers.authorization
      if (auth?.startsWith('Bearer ')) {
        token = auth.slice(7)
      }
    }

    if (!token) return null

    try {
      const payload = await verifyToken(token, this.ctx.config)
      if (payload.type !== 'runner') return null
      return payload
    } catch {
      return null
    }
  }

  // ── Connection handling ────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket, runner: RunnerTokenPayload): void {
    const { logger, registry } = this.ctx
    const teamId = runner.teamId

    logger.info({ teamId, tokenId: runner.sub }, 'Runner WebSocket connected — awaiting registration')

    ws.on('message', async (raw) => {
      let msg: RunnerMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        this.send(ws, { type: 'rpc:response', messageId: '', ok: false, error: 'Invalid JSON' })
        return
      }

      try {
        await this.handleMessage(ws, teamId, msg)
      } catch (err) {
        const messageId = 'messageId' in msg ? (msg as { messageId?: string }).messageId : undefined
        if (messageId) {
          this.send(ws, {
            type: 'rpc:response',
            messageId,
            ok: false,
            error: err instanceof Error ? err.message : 'Internal error',
          })
        }
        logger.error({ err, type: msg.type, teamId }, 'Error handling WS message')
      }
    })

    ws.on('close', (code, reason) => {
      const info = registry.unregisterByWs(ws)
      if (info?.currentJobId) {
        logger.warn({ teamId, runnerId: info.runnerId, jobId: info.currentJobId },
          'Runner disconnected mid-job')
      }
      logger.info({ teamId, code, reason: reason.toString() }, 'Runner WebSocket closed')
    })

    ws.on('error', (err) => {
      logger.error({ err, teamId }, 'Runner WebSocket error')
    })
  }

  // ── Message routing ────────────────────────────────────────────────────────

  private async handleMessage(ws: WebSocket, teamId: string, msg: RunnerMessage): Promise<void> {
    const backend = new PostgresStateBackend(this.ctx.db, teamId)

    switch (msg.type) {
      case 'runner:register':
        return this.handleRegister(ws, teamId, msg)

      case 'runner:heartbeat':
        return this.handleHeartbeat(teamId, msg)

      // ── Job CRUD ─────────────────────────────────────────────────────────
      case 'job:create': {
        const job = await backend.createJob(msg.data)
        this.reply(ws, msg.messageId, job)
        return
      }

      case 'job:get': {
        const job = await backend.getJob(msg.jobId)
        this.reply(ws, msg.messageId, job)
        return
      }

      case 'job:update': {
        const job = await backend.updateJob(msg.jobId, msg.patch)
        this.reply(ws, msg.messageId, job)
        return
      }

      case 'job:list': {
        const jobs = await backend.listJobs()
        this.reply(ws, msg.messageId, jobs)
        return
      }

      case 'job:listByType': {
        const jobs = await backend.listJobsByType(msg.jobType as import('../../jobs/types').JobType)
        this.reply(ws, msg.messageId, jobs)
        return
      }

      case 'job:listChildren': {
        const jobs = await backend.listChildJobs(msg.parentJobId)
        this.reply(ws, msg.messageId, jobs)
        return
      }

      case 'job:delete': {
        await backend.deleteJob(msg.jobId)
        this.reply(ws, msg.messageId, { ok: true })
        return
      }

      // ── Logs ─────────────────────────────────────────────────────────────
      case 'job:log': {
        for (const line of msg.lines) {
          await backend.appendLog(msg.jobId, line)
        }
        if (msg.messageId) this.reply(ws, msg.messageId, { ok: true })
        return
      }

      case 'job:logGet': {
        const lines = await backend.getLog(msg.jobId, msg.start, msg.end)
        this.reply(ws, msg.messageId, lines)
        return
      }

      case 'job:logLength': {
        const len = await backend.logLength(msg.jobId)
        this.reply(ws, msg.messageId, len)
        return
      }

      // ── PR mappings ──────────────────────────────────────────────────────
      case 'job:prMapping': {
        await backend.mapPrToJob(msg.prId, msg.jobId)
        this.reply(ws, msg.messageId, { ok: true })
        return
      }

      case 'job:prMappingAdd': {
        const job = await backend.addPrMapping(msg.jobId, msg.mapping)
        this.reply(ws, msg.messageId, job)
        return
      }

      case 'job:prMerged': {
        const job = await backend.markPrMerged(msg.jobId, msg.prId, msg.mergedAt)
        this.reply(ws, msg.messageId, job)
        return
      }

      case 'job:byPr': {
        const job = await backend.getJobByPr(msg.prId)
        this.reply(ws, msg.messageId, job)
        return
      }

      // ── Jira mappings ────────────────────────────────────────────────────
      case 'job:jiraMapping': {
        await backend.mapJiraTicketToJob(msg.ticketId, msg.jobId)
        this.reply(ws, msg.messageId, { ok: true })
        return
      }

      case 'job:byJira': {
        const job = await backend.getJobByJiraTicket(msg.ticketId)
        this.reply(ws, msg.messageId, job)
        return
      }

      // ── Repo mapping ─────────────────────────────────────────────────────
      case 'job:repoMapping': {
        await backend.mapRepoToJob(msg.repoSlug, msg.jobId)
        this.reply(ws, msg.messageId, { ok: true })
        return
      }

      // ── Lifecycle ────────────────────────────────────────────────────────
      case 'job:park': {
        await backend.updateJob(msg.jobId, { awaitingEvent: msg.awaitedEvent })
        if (msg.messageId) this.reply(ws, msg.messageId, { ok: true })
        return
      }

      case 'job:complete': {
        await backend.updateJob(msg.jobId, { status: 'complete' })
        if (msg.messageId) this.reply(ws, msg.messageId, { ok: true })
        return
      }

      // ── Proposals ────────────────────────────────────────────────────────
      case 'proposal:create': {
        const proposal = await backend.createProposal(msg.data)
        this.reply(ws, msg.messageId, proposal)
        return
      }

      case 'proposal:list': {
        const proposals = await backend.listProposals(msg.tenantId, msg.status)
        this.reply(ws, msg.messageId, proposals)
        return
      }

      case 'proposal:get': {
        const proposal = await backend.getProposal(msg.tenantId, msg.proposalId)
        this.reply(ws, msg.messageId, proposal)
        return
      }

      case 'proposal:update': {
        const proposal = await backend.updateProposal(msg.tenantId, msg.proposalId, msg.updates)
        this.reply(ws, msg.messageId, proposal)
        return
      }

      default:
        this.ctx.logger.warn({ type: (msg as { type: string }).type }, 'Unknown WS message type')
    }
  }

  // ── Register / Heartbeat ───────────────────────────────────────────────────

  private handleRegister(ws: WebSocket, teamId: string, msg: WsRunnerRegister): void {
    this.ctx.registry.register(teamId, msg.runnerId, msg.hostname, ws, msg.capabilities)

    // Deliver any pending events queued while this team had no runner
    const pending = this.ctx.registry.drainPendingEvents(teamId)
    for (const event of pending) {
      this.send(ws, event as CloudMessage)
    }

    this.ctx.logger.info({ teamId, runnerId: msg.runnerId, pendingEvents: pending.length },
      'Runner registered and pending events delivered')
  }

  private handleHeartbeat(teamId: string, msg: WsRunnerHeartbeat): void {
    this.ctx.registry.recordHeartbeat(teamId, msg.runnerId, msg.currentJobId)
  }

  // ── Send helpers ───────────────────────────────────────────────────────────

  /** Send an RPC response. */
  private reply(ws: WebSocket, messageId: string, data: unknown): void {
    this.send(ws, { type: 'rpc:response', messageId, ok: true, data })
  }

  /** Send a message to a runner. */
  send(ws: WebSocket, msg: CloudMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  /**
   * Send a message to the first available runner for a team.
   * Returns true if delivered, false if no runner is connected (queued instead).
   */
  sendToTeam(teamId: string, msg: CloudMessage): boolean {
    const runners = this.ctx.registry.getTeamRunners(teamId)
    const connected = runners.filter(r => r.ws.readyState === WebSocket.OPEN)

    if (connected.length === 0) {
      this.ctx.registry.queueEvent(teamId, msg)
      return false
    }

    // Send to the first connected runner (could be improved with load balancing)
    this.send(connected[0].ws, msg)
    return true
  }

  /**
   * Send a message to the runner handling a specific job.
   * Returns true if delivered.
   */
  sendToJob(jobId: string, msg: CloudMessage): boolean {
    const runner = this.ctx.registry.getRunnerByJob(jobId)
    if (!runner || runner.ws.readyState !== WebSocket.OPEN) return false

    this.send(runner.ws, msg)
    return true
  }

  /**
   * Result of a job-or-team delivery attempt.
   *
   *   - `route: 'job'`     — delivered to the runner that reported this job.
   *   - `route: 'team'`    — no runner claims the job, so the message went to
   *                          another connected team runner.
   *   - `route: 'queued'`  — no runner connected; message queued for the
   *                          next runner that registers.
   */
  static readonly DeliveryRoutes = ['job', 'team', 'queued'] as const

  /**
   * Try to deliver a message to the runner that is actively handling
   * `jobId`; if none claims it, fall back to any connected team runner.
   * If the team has no connected runner, the message is queued and
   * delivered on the next runner registration (matching the
   * {@link sendToTeam} contract).
   *
   * Used for control-plane events that target a specific job (resume,
   * developer message, webhook resume) — these should land on the
   * runner that actually owns the job's session whenever possible to
   * avoid cross-runner noise in multi-runner teams.
   */
  sendToJobOrTeam(
    teamId: string,
    jobId: string,
    msg: CloudMessage,
  ): { delivered: boolean; route: 'job' | 'team' | 'queued' } {
    if (this.sendToJob(jobId, msg)) {
      return { delivered: true, route: 'job' }
    }
    const delivered = this.sendToTeam(teamId, msg)
    return { delivered, route: delivered ? 'team' : 'queued' }
  }

  /** Get the registry for external access (e.g. REST endpoints). */
  getRegistry(): RunnerRegistry {
    return this.ctx.registry
  }
}
