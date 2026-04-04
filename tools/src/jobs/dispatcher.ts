import { JobInput, STATUS_CODING, STATUS_FAILED, isParkingStatus } from './types'
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

  /**
   * Create a new job from a CLI or API request and immediately start the runner.
   * Returns the created job so the HTTP response can return jobId + streamUrl.
   * The runner continues asynchronously — this method does not wait for it.
   */
  async dispatch(input: JobInput) {
    const job = await this.ctx.registry.createJob(input)
    this.ctx.logger.info({ jobId: job.id, type: job.type }, 'Job dispatched')
    this.fireAndForget(job.id)
    return job
  }

  // ── Webhook events ──────────────────────────────────────────────────────────

  /**
   * Handle an incoming BitBucket or Jira webhook event.
   * Looks up the parked job that is waiting for this event, injects the event
   * payload into the conversation history, and resumes the runner.
   */
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

    // Only resume jobs that are parked waiting for this specific event
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

    // If the job is already running (mid-turn), queue the event
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

    // Inject the event as a user message and clear the parking state
    const eventMessage = buildWebhookMessage(event.eventKey, event.payload)
    await this.ctx.registry.updateJob(jobId, {
      status: STATUS_CODING, // resume working status — agent will re-park if needed
      awaitingEvent: undefined,
      awaitingPrId: undefined,
      conversationHistory: [
        ...job.conversationHistory,
        { role: 'user', content: eventMessage },
      ],
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

        // Drain any queued webhook events that arrived while the job was running
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

function buildWebhookMessage(eventKey: string, payload: Record<string, unknown>): string {
  const lines = [`[WEBHOOK EVENT: ${eventKey}]`, `Received at: ${new Date().toISOString()}`, '']

  // Extract the most useful fields for common BitBucket PR events
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

  // For comment events, include the comment text
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

/**
 * Check whether a received BitBucket event key matches what the job is waiting for.
 * Handles both exact matches and prefix matches (e.g. "pr:fulfilled" matches "pr:fulfilled").
 */
function eventMatchesExpected(received: string, expected: string): boolean {
  return received === expected || received.startsWith(expected)
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface WebhookEvent {
  eventKey: string
  payload: Record<string, unknown>
  receivedAt: string
}
