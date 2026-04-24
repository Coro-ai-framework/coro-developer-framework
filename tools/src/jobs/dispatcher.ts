import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  Artifact,
  JobInput,
  STATUS_AWAITING_DEVELOPER_INPUT,
  STATUS_CODING,
  STATUS_COMPLETE,
  STATUS_FAILED,
  isParkingStatus,
} from './types'
import { runJob, RunnerContext } from './runner'
import type { EventTransport } from '../state/transport'

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
  private readonly activeQueries = new Map<string, Query>()

  constructor(
    private readonly ctx: RunnerContext,
    transport?: EventTransport,
  ) {
    // Register for transport events (used in Phase 3 when events arrive via WebSocket)
    if (transport) {
      transport.onEvent(async (event) => {
        await this.handleWebhookEvent(event.source, event.eventKey, event.payload)
      })
    }
  }

  // ── CLI / API triggers ──────────────────────────────────────────────────────

  async dispatch(input: JobInput) {
    const job = await this.ctx.stateBackend.createJob(input)
    this.ctx.logger.info({ jobId: job.id, type: job.type }, 'Job dispatched')
    this.fireAndForget(job.id)
    return job
  }

  // ── Manual resume ───────────────────────────────────────────────────────────

  /**
   * Resume an escalated or failed job from its current phase (or a specific phase).
   *
    * The runner persists Claude sessions by default and reuses `sessionId`
    * when it is safe to do so. Manual resume can either continue the prior
    * session or force a fresh one: if `fromPhase` changes the phase (or
    * `clearSession` is true), the agent re-enters with a rebuilt system prompt
    * and no carry-over transcript. Previously completed phases are NOT re-run
    * — the job simply re-runs the current (or selected) phase from scratch.
   *
   * If `fromPhase` differs from the current phase, the job is moved to that
   * phase before firing the runner. `clearSession` is kept for backward
   * compatibility and simply wipes `sessionId` from state when set.
   */
  async resumeJob(jobId: string, fromPhase?: string, clearSession = false): Promise<void> {
    const job = await this.ctx.stateBackend.getJob(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)

    if (this.activeJobs.has(jobId)) {
      throw new Error(`Job ${jobId} is already running`)
    }

    if (job.status === STATUS_COMPLETE) {
      throw new Error(`Job ${jobId} is already complete`)
    }

    const phaseChanged = fromPhase && fromPhase !== job.phase
    const resetSession = clearSession || phaseChanged

    await this.ctx.stateBackend.updateJob(jobId, {
      status: STATUS_CODING,
      escalationMessage: undefined,
      awaitingEvent: undefined,
      awaitingPrId: undefined,
      ...(phaseChanged ? { phase: fromPhase } : {}),
      ...(resetSession ? { sessionId: undefined } : {}),
    })

    const sessionNote = resetSession ? ' (fresh session)' : job.sessionId ? ' (resuming session)' : ''
    await this.ctx.stateBackend.appendLog(
      jobId,
      phaseChanged
        ? `[manual-resume] Restarting from phase: ${fromPhase}${sessionNote}`
        : `[manual-resume] Continuing phase: ${job.phase}${sessionNote}`,
    )

    this.ctx.logger.info({ jobId, phase: phaseChanged ? fromPhase : job.phase, phaseChanged, resetSession }, 'Manual job resume')
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

    const job = await this.ctx.stateBackend.getJobByPr(prId)
    if (!job) {
      this.ctx.logger.debug({ eventKey, prId }, 'No job found for PR — skipping')
      return
    }

    // If the job is actively running, queue the event immediately — don't wait for it to park.
    // The runner's finally() handler will replay queued events once the phase completes.
    // This prevents the race where a webhook arrives just before await_event is called.
    if (this.activeJobs.has(job.id)) {
      this.ctx.logger.debug({ jobId: job.id, eventKey }, 'Job is active — queueing webhook event for after park')
      const queue = this.eventQueue.get(job.id) ?? []
      queue.push({ eventKey, payload, receivedAt: new Date().toISOString() })
      this.eventQueue.set(job.id, queue)
      return
    }

    if (!isParkingStatus(job.status)) {
      this.ctx.logger.debug({ jobId: job.id, status: job.status }, 'Job is not parked — skipping')
      return
    }

    // Any PR event on a mapped job wakes the agent — the AI decides what to do.
    // Comments, approvals, merges, updates — all are relevant context the agent
    // should see and react to. No rigid event matching.
    await this.resumeWithEvent(job.id, eventKey, payload)
  }

  private async handleJiraEvent(
    eventKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const ticketId = extractJiraTicketId(payload)
    if (!ticketId) return

    const job = await this.ctx.stateBackend.getJobByJiraTicket(ticketId)
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
    const job = await this.ctx.stateBackend.getJob(jobId)
    if (!job) return

    const pendingPrompt = buildWebhookMessage(event.eventKey, event.payload)

    await this.ctx.stateBackend.updateJob(jobId, {
      status: STATUS_CODING,
      awaitingEvent: undefined,
      awaitingPrId: undefined,
      pendingPrompt,
    })

    await this.ctx.stateBackend.appendLog(jobId, `[webhook] Received: ${event.eventKey}`)
    this.ctx.logger.info({ jobId, eventKey: event.eventKey }, 'Resuming parked job')

    this.fireAndForget(jobId)
  }

  // ── Human message injection ─────────────────────────────────────────────────

  /**
   * Send a developer message to an agent.
   *
   * Two paths:
   *   1. Job is actively running — inject via Query.streamInput() so the live
   *      agent sees the message mid-turn (zero session rebuild).
  *   2. Job is parked waiting for developer input — build a framed prompt,
  *      clear the awaiting* fields, and resume the job in the existing Claude
  *      session. The runner re-registers the dynamic A5 MCP server before the
  *      next turn so the agent keeps both transcript continuity and MCP tools.
   *
   * Any other status (complete, failed, queued without a live query) throws.
   */
  async sendMessage(jobId: string, message: string): Promise<void> {
    const q = this.activeQueries.get(jobId)

    if (q) {
      const framedText =
        `[DEVELOPER MESSAGE]\n` +
        `The developer watching this job has sent you a message:\n\n` +
        `"${message}"\n\n` +
        `Consider this guidance in your current work. If it changes your approach, ` +
        `acknowledge it and adjust accordingly. Continue with your current phase instructions.\n\n` +
        `If this guidance represents a reusable pattern or convention that should apply to future jobs, ` +
        `record it via the \`add_insight\` tool so the Evaluator can review it.`

      const userMsg: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: framedText }] },
        parent_tool_use_id: null,
      }

      try {
        await q.streamInput((async function* () { yield userMsg })())
      } catch (err) {
        this.ctx.logger.warn({ jobId, err }, 'streamInput failed — query may have ended')
        throw new Error('Failed to inject message — the agent query may have just finished')
      }

      await this.ctx.stateBackend.appendLog(jobId, `[human] ${message}`)
      this.ctx.logger.info({ jobId }, 'Developer message injected into running agent')
      return
    }

    // No live query — check if the job is parked waiting for developer input.
    const job = await this.ctx.stateBackend.getJob(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)

    if (job.status !== STATUS_AWAITING_DEVELOPER_INPUT) {
      throw new Error(
        `Cannot send message to job with status "${job.status}" — ` +
        `only running jobs and jobs awaiting developer input accept messages.`,
      )
    }

    if (this.activeJobs.has(jobId)) {
      throw new Error('Job is transitioning — try again in a moment')
    }

    const pendingPrompt = buildDeveloperInputMessage(
      message,
      job.phase,
      job.awaitingEvent,
      (job.artifacts ?? []).filter(a => a.phase === job.phase),
    )

    await this.ctx.stateBackend.updateJob(jobId, {
      status: STATUS_CODING,
      awaitingEvent: undefined,
      awaitingPrId: undefined,
      awaitingNextPhase: undefined,
      approvedAdvanceFromPhase: job.awaitingNextPhase ? job.phase : undefined,
      pendingPrompt,
    })

    await this.ctx.stateBackend.appendLog(jobId, `[human] ${message}`)
    this.ctx.logger.info({ jobId, phase: job.phase }, 'Resuming parked job with developer message')

    this.fireAndForget(jobId)
  }

  // ── Fire-and-forget runner ──────────────────────────────────────────────────

  private fireAndForget(jobId: string): void {
    if (this.activeJobs.has(jobId)) {
      this.ctx.logger.warn({ jobId }, 'Runner already active for this job — skipping')
      return
    }

    this.activeJobs.add(jobId)

    this.ctx.stateBackend
      .getJob(jobId)
      .then(job => {
        if (!job) throw new Error(`Job not found: ${jobId}`)
        return runJob(job, this.ctx, {
          onQueryStart: (id, q) => this.activeQueries.set(id, q),
          onQueryEnd: (id) => this.activeQueries.delete(id),
        })
      })
      .catch(err => {
        this.ctx.logger.error({ err, jobId }, 'Runner crashed unexpectedly')
        return this.ctx.stateBackend
          .updateJob(jobId, {
            status: STATUS_FAILED,
            escalationMessage: `Runner crashed: ${String(err)}`,
          })
          .catch(() => {})
      })
      .finally(async () => {
        this.activeJobs.delete(jobId)

        // Process at most ONE queued event. injectAndResume calls fireAndForget
        // which will eventually hit this finally block again for the next event.
        const queued = this.eventQueue.get(jobId)
        if (!queued || queued.length === 0) {
          this.eventQueue.delete(jobId)
          return
        }

        const next = queued.shift()!
        if (queued.length === 0) this.eventQueue.delete(jobId)

        const job = await this.ctx.stateBackend.getJob(jobId)
        if (!job || !isParkingStatus(job.status)) {
          this.eventQueue.delete(jobId)
          return
        }

        await this.injectAndResume(jobId, next)
      })
  }
}

// ── Developer input message builder ───────────────────────────────────────────

/**
 * Build the framed prompt the runner will send to the agent when a developer
 * responds to a paused-for-developer-input park.
 *
 * The runner now enforces workflow interactive checkpoints at phase
 * boundaries. Agents can still call `await_event('developer-input: <reason>')`
 * for additional mid-phase questions (approval, clarification, design choice).
 * This builder relays the developer's reply and reminds the agent to:
 *
 *   1. Apply the guidance and finish the phase as normal (the runner will
 *      auto-advance — or the agent can call `goto_phase` to loop back).
 *   2. Capture reusable guidance via `add_insight` for the evaluator.
 */
export function buildDeveloperInputMessage(
  message: string,
  phase: string,
  awaitingEvent: string | undefined,
  currentPhaseArtifacts: Artifact[],
): string {
  const reason = awaitingEvent?.startsWith('developer-input:')
    ? awaitingEvent.slice('developer-input:'.length).trim()
    : ''

  const lines = [
    '[DEVELOPER RESPONSE]',
    '',
    `You paused during phase: ${phase}.`,
  ]

  if (reason) {
    lines.push(`You were waiting for input on: "${reason}".`)
  }

  if (currentPhaseArtifacts.length > 0) {
    lines.push('', 'Artefacts you posted this phase:')
    for (const a of currentPhaseArtifacts.slice(-10)) {
      lines.push(`  - ${a.kind}: ${a.title}`)
    }
  }

  lines.push(
    '',
    'Developer said:',
    `"${message}"`,
    '',
    'Use the developer\'s answer to continue. Finish the phase normally when done — the ' +
    'runner will auto-advance. If you need to revisit an earlier phase (e.g. rework after ' +
    'a review comment), call `goto_phase`. If this reply contains a reusable pattern or ' +
    'convention, record it via `add_insight` so the evaluator can review it.',
  )

  return lines.join('\n')
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

// ── Types ─────────────────────────────────────────────────────────────────────

interface WebhookEvent {
  eventKey: string
  payload: Record<string, unknown>
  receivedAt: string
}
