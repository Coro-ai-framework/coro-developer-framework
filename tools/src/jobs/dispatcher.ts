import { JobInput, STATUS_CODING, STATUS_FAILED, isParkingStatus, isTerminalStatus } from './types'
import { runJob, RunnerContext } from './runner'

// ── Dispatcher ────────────────────────────────────────────────────────────────
//
// Routes job creation requests and incoming webhook events to the runner.
//
// Concurrency model:
//   - activeJobs tracks which jobs are currently running
//   - A job can only run once at a time (webhook events queue if a run is active)
//   - Queued events are replayed in order when the job finishes its current turn

export class Dispatcher {
  private readonly activeJobs = new Set<string>()
  private readonly eventQueue = new Map<string, WebhookEvent[]>()

  constructor(private readonly ctx: RunnerContext) {}

  // ── CLI / API triggers ──────────────────────────────────────────────────────

  async dispatch(input: JobInput) {
    const job = await this.ctx.registry.createJob(input)
    this.ctx.logger.info({ jobId: job.id, type: job.type }, 'Job dispatched')
    this.fireAndForget(job.id)
    return job
  }

  // ── Manual resume ───────────────────────────────────────────────────────────

  /**
   * Resume an escalated or failed job from its current phase (or a specific phase).
   *
   * If `fromPhase` matches the job's current phase, the existing Agent SDK session
   * is reused (`resume: sessionId`) so the conversation continues exactly where it
   * stopped — previously completed phases are NOT re-run.
   *
   * If `fromPhase` differs from the current phase, the job is moved to that phase
   * and the session is reset (Claude starts fresh for that phase).
   */
  async resumeJob(jobId: string, fromPhase?: string): Promise<void> {
    const job = await this.ctx.registry.getJob(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)

    if (!isTerminalStatus(job.status) && !isParkingStatus(job.status)) {
      throw new Error(`Job ${jobId} is not in a resumable state (status: ${job.status})`)
    }

    if (this.activeJobs.has(jobId)) {
      throw new Error(`Job ${jobId} is already running`)
    }

    const phaseChanged = fromPhase && fromPhase !== job.phase

    await this.ctx.registry.updateJob(jobId, {
      status: STATUS_CODING,
      escalationMessage: undefined,
      awaitingEvent: undefined,
      awaitingPrId: undefined,
      ...(phaseChanged ? { phase: fromPhase, sessionId: undefined } : {}),
    })

    await this.ctx.registry.appendLog(
      jobId,
      phaseChanged
        ? `[manual-resume] Restarting from phase: ${fromPhase}`
        : `[manual-resume] Continuing phase: ${job.phase}${job.sessionId ? ' (resuming session)' : ''}`,
    )

    this.ctx.logger.info({ jobId, phase: phaseChanged ? fromPhase : job.phase, phaseChanged }, 'Manual job resume')
    this.fireAndForget(jobId)
  }

  // ── Webhook events ──────────────────────────────────────────────────────────

  async handleWebhookEvent(
    source: 'bitbucket' | 'jira',
    eventKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (source === 'bitbucket') {
      await this.handleBitBucketEvent(eventKey, payload)
    } else {
      await this.handleJiraEvent(eventKey, payload)
    }
  }

  // ── BitBucket event handling ────────────────────────────────────────────────

  private async handleBitBucketEvent(
    eventKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const prId = extractBbPrId(payload)
    if (prId === null) {
      this.ctx.logger.debug({ eventKey }, 'BitBucket event has no PR ID — skipping')
      return
    }

    const job = await this.ctx.registry.getJobByPr(prId)
    if (!job) {
      this.ctx.logger.debug({ eventKey, prId }, 'No job found for PR — skipping')
      return
    }

    if (!isParkingStatus(job.status)) {
      this.ctx.logger.debug({ jobId: job.id, status: job.status }, 'Job is not parked — skipping')
      return
    }

    if (job.awaitingEvent && !eventMatchesExpected(eventKey, job.awaitingEvent)) {
      this.ctx.logger.debug(
        { jobId: job.id, received: eventKey, awaiting: job.awaitingEvent },
        'Event does not match what job is waiting for — skipping',
      )
      return
    }

    await this.resumeWithEvent(job.id, eventKey, payload)
  }

  private async handleJiraEvent(
    eventKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const ticketId = extractJiraTicketId(payload)
    if (!ticketId) return

    const job = await this.ctx.registry.getJobByJiraTicket(ticketId)
    if (!job || !isParkingStatus(job.status)) return

    await this.resumeWithEvent(job.id, eventKey, payload)
  }

  // ── Resume ──────────────────────────────────────────────────────────────────

  private async resumeWithEvent(
    jobId: string,
    eventKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const event: WebhookEvent = { eventKey, payload, receivedAt: new Date().toISOString() }

    if (this.activeJobs.has(jobId)) {
      this.ctx.logger.debug({ jobId, eventKey }, 'Job is active — queueing webhook event')
      const queue = this.eventQueue.get(jobId) ?? []
      queue.push(event)
      this.eventQueue.set(jobId, queue)
      return
    }

    await this.injectAndResume(jobId, event)
  }

  private async injectAndResume(jobId: string, event: WebhookEvent): Promise<void> {
    const job = await this.ctx.registry.getJob(jobId)
    if (!job) return

    // Clear the parking state — the runner will pick up the event context
    // via the webhook message injected as the prompt for the resumed session.
    await this.ctx.registry.updateJob(jobId, {
      status: STATUS_CODING,
      awaitingEvent: undefined,
      awaitingPrId: undefined,
    })

    await this.ctx.registry.appendLog(jobId, `[webhook] Received: ${event.eventKey}`)
    this.ctx.logger.info({ jobId, eventKey: event.eventKey }, 'Resuming parked job')

    this.fireAndForget(jobId)
  }

  // ── Fire-and-forget runner ──────────────────────────────────────────────────

  private fireAndForget(jobId: string): void {
    if (this.activeJobs.has(jobId)) {
      this.ctx.logger.warn({ jobId }, 'Runner already active for this job — skipping')
      return
    }

    this.activeJobs.add(jobId)

    this.ctx.registry
      .getJob(jobId)
      .then(job => {
        if (!job) throw new Error(`Job not found: ${jobId}`)
        return runJob(job, this.ctx)
      })
      .catch(err => {
        this.ctx.logger.error({ err, jobId }, 'Runner crashed unexpectedly')
        return this.ctx.registry
          .updateJob(jobId, {
            status: STATUS_FAILED,
            escalationMessage: `Runner crashed: ${String(err)}`,
          })
          .catch(() => {})
      })
      .finally(async () => {
        this.activeJobs.delete(jobId)

        const queued = this.eventQueue.get(jobId) ?? []
        this.eventQueue.delete(jobId)

        for (const event of queued) {
          const job = await this.ctx.registry.getJob(jobId)
          if (!job || !isParkingStatus(job.status)) break
          await this.injectAndResume(jobId, event)
        }
      })
  }
}

// ── Webhook message builder ───────────────────────────────────────────────────

export function buildWebhookMessage(eventKey: string, payload: Record<string, unknown>): string {
  const lines = [`[WEBHOOK EVENT: ${eventKey}]`, `Received at: ${new Date().toISOString()}`, '']

  const pr = payload['pullrequest'] as Record<string, unknown> | undefined
  if (pr) {
    const id = pr['id']
    const title = pr['title']
    const state = pr['state']
    const author = (pr['author'] as Record<string, unknown> | undefined)?.['display_name']
    const source = ((pr['source'] as Record<string, unknown> | undefined)?.['branch'] as Record<string, unknown> | undefined)?.['name']
    const dest = ((pr['destination'] as Record<string, unknown> | undefined)?.['branch'] as Record<string, unknown> | undefined)?.['name']

    if (id) lines.push(`PR #${id}: ${String(title ?? '')}`)
    if (state) lines.push(`State: ${state}`)
    if (source && dest) lines.push(`Branch: ${source} → ${dest}`)
    if (author) lines.push(`Author: ${author}`)
  }

  const comment = payload['comment'] as Record<string, unknown> | undefined
  if (comment) {
    const content = (comment['content'] as Record<string, unknown> | undefined)?.['raw']
    const commenter = (comment['user'] as Record<string, unknown> | undefined)?.['display_name']
    if (commenter) lines.push(`\nComment by ${commenter}:`)
    if (content) lines.push(String(content))
  }

  lines.push('')
  lines.push('Please continue your work based on this event. Refer to your current phase instructions.')

  return lines.join('\n')
}

// ── Payload extraction helpers ────────────────────────────────────────────────

function extractBbPrId(payload: Record<string, unknown>): number | null {
  const pr = payload['pullrequest'] as Record<string, unknown> | undefined
  const id = pr?.['id']
  if (typeof id === 'number') return id
  if (typeof id === 'string') {
    const n = parseInt(id, 10)
    return isNaN(n) ? null : n
  }
  return null
}

function extractJiraTicketId(payload: Record<string, unknown>): string | null {
  const issue = payload['issue'] as Record<string, unknown> | undefined
  const key = issue?.['key']
  return typeof key === 'string' ? key : null
}

function eventMatchesExpected(received: string, expected: string): boolean {
  return received === expected || received.startsWith(expected)
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface WebhookEvent {
  eventKey: string
  payload: Record<string, unknown>
  receivedAt: string
}
