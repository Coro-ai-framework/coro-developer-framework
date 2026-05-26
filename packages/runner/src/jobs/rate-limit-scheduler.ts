// ── RateLimitScheduler ────────────────────────────────────────────────────────
//
// In-process timer registry that auto-resumes jobs parked into
// {@link STATUS_AWAITING_RATE_LIMIT}. The runner asks us to schedule a
// wake-up at `resumeAt` (epoch ms); when the timer fires we re-dispatch
// the job through the dispatcher's standard `resumeJob()` path so the
// runner reads the job back from state, sees its sessionId is still
// set, and continues from where the executor threw — no phase change,
// no escalation, no pendingPrompt.
//
// The scheduler is intentionally tiny and host-local: it does NOT
// persist timers. On runner restart we re-discover parked jobs from
// state and re-arm timers via `bootstrap()`. Resume deadlines that
// already passed during downtime fire immediately (delay clamped to 0).

import type { Logger } from 'pino'
import type { StateBackend } from '../state/backend'
import { STATUS_AWAITING_RATE_LIMIT } from '@coro-ai/cloud-protocol'

/** Anything the scheduler needs from the dispatcher — narrowed for testability. */
export interface RateLimitResumer {
  /**
   * Returns `true` if the job currently has an active runner (and the
   * scheduled wake-up should therefore be skipped).
   */
  isActiveJob(jobId: string): boolean
  /**
   * Re-enters the runner for `jobId`. Mirrors the dispatcher's
   * `resumeJob()` but only takes the id — the scheduler never knows
   * about phases or prompts.
   */
  resumeJob(jobId: string): Promise<void>
}

export class RateLimitScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly resumer: RateLimitResumer,
    private readonly stateBackend: StateBackend,
    private readonly logger: Logger,
  ) {}

  /**
   * Arm a wake-up for `jobId` at `resumeAt` (epoch ms). Replaces any
   * existing timer for the same job — the runner only ever issues one
   * fresh deadline per park, so this is the natural shape.
   */
  schedule(jobId: string, resumeAt: number): void {
    this.cancel(jobId)
    const delay = Math.max(0, resumeAt - Date.now())
    const timer = setTimeout(() => {
      this.timers.delete(jobId)
      void this.fire(jobId)
    }, delay)
    // Don't keep the Node process alive purely waiting for a wake-up.
    timer.unref?.()
    this.timers.set(jobId, timer)
    this.logger.debug({ jobId, resumeAt, delay }, 'RateLimitScheduler armed')
  }

  /** Drop the wake-up for `jobId` if armed. Safe to call when none exists. */
  cancel(jobId: string): void {
    const existing = this.timers.get(jobId)
    if (!existing) return
    clearTimeout(existing)
    this.timers.delete(jobId)
    this.logger.debug({ jobId }, 'RateLimitScheduler cancelled')
  }

  /**
   * On runner start, re-arm timers for every job currently parked in
   * `awaiting-rate-limit`. Jobs whose deadline already passed fire
   * immediately. Idempotent — safe to call multiple times.
   */
  async bootstrap(): Promise<void> {
    let jobs: Array<{ id: string; status: string; rateLimitInfo?: { resumeAt: number } }>
    try {
      jobs = (await this.stateBackend.listJobs()) as typeof jobs
    } catch (err) {
      this.logger.warn({ err }, 'RateLimitScheduler.bootstrap — listJobs failed')
      return
    }
    let armed = 0
    for (const job of jobs) {
      if (job.status !== STATUS_AWAITING_RATE_LIMIT) continue
      const resumeAt = job.rateLimitInfo?.resumeAt
      if (typeof resumeAt !== 'number') continue
      this.schedule(job.id, resumeAt)
      armed++
    }
    this.logger.info({ armed }, 'RateLimitScheduler bootstrap complete')
  }

  /** Internal: actually re-dispatch the job. Guards against races. */
  private async fire(jobId: string): Promise<void> {
    try {
      // Race guard: if another path already resumed the job (manual
      // resume, cancel, pause) skip the wake-up.
      if (this.resumer.isActiveJob(jobId)) {
        this.logger.debug({ jobId }, 'RateLimitScheduler fire skipped — job already active')
        return
      }
      const job = await this.stateBackend.getJob(jobId)
      if (!job) {
        this.logger.warn({ jobId }, 'RateLimitScheduler fire — job no longer exists')
        return
      }
      if (job.status !== STATUS_AWAITING_RATE_LIMIT) {
        // Cancelled, resumed manually, or transitioned by another path.
        this.logger.debug({ jobId, status: job.status }, 'RateLimitScheduler fire skipped — status no longer rate-limit')
        return
      }
      this.logger.info({ jobId }, 'RateLimitScheduler firing — auto-resuming rate-limited job')
      await this.resumer.resumeJob(jobId)
    } catch (err) {
      this.logger.error({ err, jobId }, 'RateLimitScheduler.fire failed')
    }
  }
}
