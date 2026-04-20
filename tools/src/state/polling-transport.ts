// ── Polling Transport ─────────────────────────────────────────────────────────
//
// EventTransport implementation for fully local mode (Phase 5). Instead of
// receiving webhook events in real-time, polls the BitBucket/GitHub API at a
// fixed interval to detect PR state changes (comments, approvals, merges).
//
// Latency: ~60 seconds (acceptable for jobs that take hours).
// Used when: `a5 init --local` → no cloud, no webhook endpoint.
//
// The transport checks all parked jobs that have `awaitingPrId` set, fetches
// their current PR status and comment count, and delivers synthetic webhook
// events when changes are detected.

import type { EventTransport } from './transport'
import type { InboundEvent, OutboundEvent } from './events'
import type { StateBackend } from './backend'
import type { Logger } from 'pino'
import { isParkingStatus } from '../jobs/types'

export interface PrPoller {
  getPrStatus(repoSlug: string, prId: number): Promise<{ state: string; approvalCount: number }>
  getComments(repoSlug: string, prId: number): Promise<Array<{ id: number; content: { raw: string }; created_on: string }>>
}

export interface PollingTransportOptions {
  stateBackend: StateBackend
  /** The git API client (BitBucket or GitHub) that can poll PR state. */
  prPoller: PrPoller
  /** Repo slug for PR API calls (for jobs that don't store it). */
  defaultRepoSlug?: string
  /** Poll interval in milliseconds. Default: 60000 (60s). */
  intervalMs?: number
  logger: Logger
}

/** Snapshot of a PR's last-known state for change detection. */
interface PrSnapshot {
  state: string
  approvalCount: number
  commentCount: number
}

export class PollingTransport implements EventTransport {
  private handler?: (event: InboundEvent) => Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private connected = false
  private polling = false

  private readonly intervalMs: number
  private readonly stateBackend: StateBackend
  private readonly prPoller: PrPoller
  private readonly defaultRepoSlug: string
  private readonly logger: Logger

  /** Cache of last-seen PR state to detect changes. */
  private readonly snapshots = new Map<number, PrSnapshot>()

  constructor(opts: PollingTransportOptions) {
    this.stateBackend = opts.stateBackend
    this.prPoller = opts.prPoller
    this.defaultRepoSlug = opts.defaultRepoSlug ?? ''
    this.intervalMs = opts.intervalMs ?? 60_000
    this.logger = opts.logger
  }

  async connect(): Promise<void> {
    if (this.connected) return
    this.connected = true

    // Start polling loop
    this.timer = setInterval(() => {
      void this.poll()
    }, this.intervalMs)

    this.logger.info({ intervalMs: this.intervalMs }, 'Polling transport started')
  }

  async disconnect(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.connected = false
    this.snapshots.clear()
    this.logger.info('Polling transport stopped')
  }

  isConnected(): boolean {
    return this.connected
  }

  onEvent(handler: (event: InboundEvent) => Promise<void>): void {
    this.handler = handler
  }

  async emit(_event: OutboundEvent): Promise<void> {
    // No-op for local mode — no cloud to emit to.
    // Log lines go directly to SQLite via StateBackend.
  }

  // ── Polling loop ──────────────────────────────────────────────────────────

  /**
   * Manually trigger a poll cycle (useful for tests or on-demand checks).
   */
  async poll(): Promise<void> {
    if (this.polling) return  // Skip if previous poll is still running
    this.polling = true

    try {
      const jobs = await this.stateBackend.listJobs()
      const parkedJobs = jobs.filter(j =>
        isParkingStatus(j.status) && j.awaitingPrId && j.prMappings.length > 0
      )

      if (parkedJobs.length === 0) return

      this.logger.debug({ count: parkedJobs.length }, 'Polling parked jobs for PR changes')

      for (const job of parkedJobs) {
        const prId = job.awaitingPrId!
        const repoSlug = this.resolveRepoSlug(job)

        if (!repoSlug) {
          this.logger.warn({ jobId: job.id, prId }, 'Cannot poll PR — no repoSlug found')
          continue
        }

        try {
          await this.checkPr(job.id, repoSlug, prId)
        } catch (err) {
          this.logger.warn({ jobId: job.id, prId, err }, 'PR poll failed — will retry next cycle')
        }
      }
    } finally {
      this.polling = false
    }
  }

  // ── PR change detection ────────────────────────────────────────────────────

  private async checkPr(jobId: string, repoSlug: string, prId: number): Promise<void> {
    const [status, comments] = await Promise.all([
      this.prPoller.getPrStatus(repoSlug, prId),
      this.prPoller.getComments(repoSlug, prId),
    ])

    const current: PrSnapshot = {
      state: status.state,
      approvalCount: status.approvalCount,
      commentCount: comments.length,
    }

    const previous = this.snapshots.get(prId)
    this.snapshots.set(prId, current)

    // First poll — just cache, don't fire events
    if (!previous) {
      this.logger.debug({ prId, state: current.state }, 'Initial PR snapshot cached')
      return
    }

    // Detect state changes and deliver synthetic events
    if (current.state !== previous.state) {
      if (current.state === 'MERGED') {
        await this.deliver(jobId, 'pullrequest:fulfilled', { prId, state: 'MERGED' })
      } else if (current.state === 'DECLINED') {
        await this.deliver(jobId, 'pullrequest:rejected', { prId, state: 'DECLINED' })
      } else {
        await this.deliver(jobId, 'pullrequest:updated', { prId, state: current.state })
      }
    }

    if (current.approvalCount > previous.approvalCount) {
      await this.deliver(jobId, 'pullrequest:approved', {
        prId,
        approvalCount: current.approvalCount,
      })
    }

    if (current.commentCount > previous.commentCount) {
      // Fetch the new comments to include in the event
      const newComments = comments.slice(previous.commentCount)
      for (const comment of newComments) {
        await this.deliver(jobId, 'pullrequest:comment_created', {
          prId,
          comment: {
            id: comment.id,
            content: comment.content,
            created_on: comment.created_on,
          },
        })
      }
    }
  }

  private async deliver(jobId: string, eventKey: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.handler) return

    this.logger.info({ jobId, eventKey }, 'Polling detected PR change — delivering event')

    const event: InboundEvent = {
      source: 'bitbucket',  // Works for both BB and GH — the dispatcher doesn't care
      eventKey,
      payload: {
        ...payload,
        pullrequest: {
          id: payload['prId'],
          state: payload['state'],
        },
      },
      receivedAt: new Date().toISOString(),
    }

    await this.handler(event)
  }

  private resolveRepoSlug(job: { params: Record<string, unknown>; prMappings: Array<{ repoSlug: string }> }): string {
    // Try prMappings first (most reliable)
    for (const pm of job.prMappings) {
      if (pm.repoSlug) return pm.repoSlug
    }
    // Fall back to job params
    if (job.params['repoSlug']) return job.params['repoSlug'] as string
    if (job.params['repo']) return job.params['repo'] as string
    return this.defaultRepoSlug
  }
}
