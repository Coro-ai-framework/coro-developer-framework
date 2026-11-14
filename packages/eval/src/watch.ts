import type { Job } from '@coro-ai/cloud-protocol'
import { isNeedsHumanStatus, isStoppedStatus, STATUS } from './coro-client'
import type { ReviewerAction } from './reviewer'
import { describeAction } from './reviewer'
import type { AttemptOutcome, Timeline, TimelineEntry } from './types'
import { sleep as realSleep } from './util'

/**
 * The attempt's watch loop: poll the job, keep a timeline, let the simulated
 * reviewer act, and decide when the attempt is over.
 *
 * Polling `GET /jobs/:id` is the source of truth. The log stream is only a
 * convenience for a human reading `job.log`.
 */

export interface WatchOptions {
  client: {
    getJob(jobId: string): Promise<Job>
    cancel(jobId: string): Promise<void>
  }
  reviewer: { tick(job: Pick<Job, 'status'>): Promise<ReviewerAction[]> }
  jobId: string
  /** After this long the job is cancelled and the attempt ends as `timeout`. */
  timeoutMs: number
  pollMs: number
  /**
   * A job parked for a person (`awaiting-developer-input`, `awaiting-plan-approval`)
   * will wait forever here. Give it this long in case the park is momentary, then
   * end the attempt as `needs-human`.
   */
  needsHumanGraceMs: number
  /** False once the runner process has died. */
  runnerAlive: () => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface WatchResult {
  outcome: AttemptOutcome
  /** The last job record read, if any poll succeeded. */
  job?: Job
  timeline: Timeline
  error?: string
}

const OUTCOME_BY_STATUS: Record<string, AttemptOutcome> = {
  [STATUS.complete]: 'complete',
  [STATUS.failed]: 'failed',
  [STATUS.escalated]: 'escalated',
  [STATUS.cancelled]: 'cancelled',
}

/** Consecutive failed polls tolerated while the runner process is still alive. */
const MAX_POLL_FAILURES = 6

/** How long to wait for a cancelled job to actually stop. */
const CANCEL_SETTLE_MS = 30_000

export async function watchJob(options: WatchOptions): Promise<WatchResult> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? realSleep
  const startedAt = now()
  const dispatchedAt = new Date(startedAt).toISOString()
  const entries: TimelineEntry[] = []

  let lastJob: Job | undefined
  let lastKey = ''
  let needsHumanSince: number | undefined
  let pollFailures = 0
  let lastReviewerError = ''

  const record = (job: Job | undefined, event?: string): void => {
    const status = job?.status ?? entries[entries.length - 1]?.status ?? 'unknown'
    const phase = job?.phase ?? entries[entries.length - 1]?.phase ?? ''
    entries.push({
      at: new Date(now()).toISOString(),
      elapsedMs: now() - startedAt,
      status,
      phase,
      ...(event ? { event } : {}),
    })
  }

  const finish = (outcome: AttemptOutcome, error?: string): WatchResult => ({
    outcome,
    ...(lastJob ? { job: lastJob } : {}),
    timeline: { dispatchedAt, endedAt: new Date(now()).toISOString(), entries },
    ...(error ? { error } : {}),
  })

  const tickReviewer = async (job: Job): Promise<void> => {
    try {
      for (const action of await options.reviewer.tick(job)) record(job, describeAction(action))
    } catch (error) {
      // A reviewer hiccup must not end the attempt; say so once per distinct message.
      const message = error instanceof Error ? error.message : String(error)
      if (message !== lastReviewerError) {
        lastReviewerError = message
        record(job, `reviewer error: ${message}`)
      }
    }
  }

  for (;;) {
    if (!options.runnerAlive()) {
      return finish('runner-crashed', 'the runner process exited while the job was running')
    }

    let job: Job | undefined
    try {
      job = await options.client.getJob(options.jobId)
      lastJob = job
      pollFailures = 0
    } catch (error) {
      pollFailures++
      if (pollFailures >= MAX_POLL_FAILURES && !options.runnerAlive()) {
        return finish('runner-crashed', error instanceof Error ? error.message : String(error))
      }
    }

    if (job) {
      const key = `${job.status}|${job.phase}`
      if (key !== lastKey) {
        lastKey = key
        record(job)
      }

      await tickReviewer(job)

      if (isStoppedStatus(job.status)) {
        return finish(OUTCOME_BY_STATUS[job.status] ?? 'failed')
      }

      if (isNeedsHumanStatus(job.status)) {
        needsHumanSince ??= now()
        if (now() - needsHumanSince >= options.needsHumanGraceMs) {
          return finish('needs-human', `job is waiting for a person (${job.status}${job.awaitingEvent ? `: ${job.awaitingEvent}` : ''})`)
        }
      } else {
        needsHumanSince = undefined
      }
    }

    if (now() - startedAt >= options.timeoutMs) {
      record(lastJob, 'harness: timeout, cancelling the job')
      try {
        await options.client.cancel(options.jobId)
      } catch {
        // already stopped, or the runner is unreachable; settle below either way
      }
      const settleBy = now() + CANCEL_SETTLE_MS
      while (now() < settleBy) {
        try {
          lastJob = await options.client.getJob(options.jobId)
          if (isStoppedStatus(lastJob.status)) break
        } catch {
          break
        }
        await sleep(Math.min(options.pollMs, 1_000))
      }
      if (lastJob) record(lastJob)
      return finish('timeout', `no result within ${Math.round(options.timeoutMs / 60_000)} minutes`)
    }

    await sleep(options.pollMs)
  }
}

/**
 * Milliseconds the job spent parked on a pull request. Counted as review
 * latency, not agent time: it includes the simulated reviewer's delay and the
 * runner's own poll interval for noticing an approval.
 */
export function reviewWaitMs(timeline: Timeline): number {
  const end = Date.parse(timeline.endedAt)
  const start = Date.parse(timeline.dispatchedAt)
  if (!Number.isFinite(end) || !Number.isFinite(start)) return 0
  const endElapsed = end - start

  let total = 0
  let parkedFrom: number | undefined
  for (const entry of timeline.entries) {
    if (entry.status === STATUS.awaitingPrMerge) {
      parkedFrom ??= entry.elapsedMs
    } else if (parkedFrom !== undefined) {
      total += Math.max(0, entry.elapsedMs - parkedFrom)
      parkedFrom = undefined
    }
  }
  if (parkedFrom !== undefined) total += Math.max(0, endElapsed - parkedFrom)
  return total
}
