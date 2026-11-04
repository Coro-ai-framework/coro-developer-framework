import type { Logger } from 'pino'
import type { LocalConfig } from '../config/local-config'
import { createRunnerCore, tempReviewDbPath } from '../runner/core'
import { ReviewCoordinator } from './coordinator'
import { eventsFromCi } from './ci-source'
import { createRoundPipeline } from './engine'
import { PrMarkerReviewStore } from './marker-store'
import { parsePrUrl } from './id'
import type { ScmPluginRuntime } from '../plugins/types'

export interface OnceOptions {
  config: LocalConfig | null
  logger: Logger
  prUrl?: string
  eventPath?: string
  eventName?: string
  failOn?: 'blocker'
}

/**
 * One CI round. No HTTP server, no debounce. State is the sticky marker
 * comment on the pull request. Exit code is 0 unless `--fail-on blocker`
 * and an open blocker remains.
 */
export async function runReviewOnce(opts: OnceOptions): Promise<number> {
  const events = await eventsFromCi({
    prUrl: opts.prUrl,
    eventPath: opts.eventPath ?? process.env.GITHUB_EVENT_PATH,
    eventName: opts.eventName ?? process.env.GITHUB_EVENT_NAME,
  })
  if (events.length === 0) {
    opts.logger.error('No pull request event. Pass --pr or run inside GitHub Actions.')
    return 1
  }
  const ref = events[0]!.prRef
  const core = await createRunnerCore({
    config: opts.config,
    logger: opts.logger,
    dbPath: tempReviewDbPath(),
  })
  const scm = core.plugins.byId(ref.pluginId) as ScmPluginRuntime | undefined
  if (!scm?.submitReview) {
    opts.logger.error({ pluginId: ref.pluginId }, 'SCM plugin cannot submit reviews')
    core.stateBackend.close()
    return 1
  }
  const store = new PrMarkerReviewStore(
    core.stateBackend.reviews,
    async () => {
      if (scm.listPrComments) {
        return (await scm.listPrComments(ref)).map(comment => ({ id: String(comment.id), body: comment.body }))
      }
      if (scm.pollPr) return (await scm.pollPr(ref)).comments.map(comment => ({ id: String(comment.id), body: comment.body }))
      return []
    },
    async (body, existingId) => {
      if (existingId && scm.updatePrComment) {
        await scm.updatePrComment(ref, existingId, body)
        return { id: existingId }
      }
      if (scm.postPrComment) {
        const posted = await scm.postPrComment(ref, body)
        return { id: String(posted.id) }
      }
      await scm.submitReview!(ref, { event: 'comment', body, comments: [] })
      return undefined
    },
  )
  await store.hydrate()
  const policy = core.settings.reviews
  if (!policy) {
    core.stateBackend.close()
    return 1
  }
  // Nobody is there to approve a draft in CI, including one a repo asked for.
  const roundPolicy = { ...policy, debounceSec: 0, enabled: true, approveBeforePosting: false }
  const login = scm.whoami ? (await scm.whoami()).login : 'ci'
  const pipeline = await createRoundPipeline(core.runnerCtx, core.dispatcher, roundPolicy, { interactive: false })
  let ran = false
  const coordinator = new ReviewCoordinator({
    store,
    policy: roundPolicy,
    reviewerLogin: login,
    identityMode: 'bot',
    setTimer: (fn) => {
      queueMicrotask(fn)
      return { clear() {} }
    },
    dispatchRound: async (review, kind, batch) => {
      ran = true
      return pipeline.dispatchRound(review, kind, batch)
    },
    assess: pipeline.assess,
    log: (msg, extra) => opts.logger.info(extra ?? {}, msg),
  })
  core.dispatcher.setRoundStoppedHandler(job => coordinator.onRoundStopped(job))
  let reviewId: string | undefined
  for (const event of events) {
    const review = await coordinator.ingest(event)
    reviewId = review?.id ?? reviewId
  }
  if (reviewId) {
    await waitForSettled(store, reviewId, false)
    if (ran) {
      const review = await store.get(reviewId)
      const jobId = review?.rounds[review.rounds.length - 1]?.jobId
      if (jobId) await waitForJob(core, jobId)
      await waitForSettled(store, reviewId, true)
    }
    await store.flush(reviewId)
  }
  const review = reviewId ? await store.get(reviewId) : null
  const blockers = review?.ledger.findings.filter(finding => finding.status === 'open' && finding.severity === 'blocker').length ?? 0
  core.stateBackend.close()
  if (opts.failOn === 'blocker' && blockers > 0) return 2
  return 0
}

/**
 * Waits until the coordinator has dispatched the round (or decided not to),
 * or, with `untilRoundEnds`, until the stop handler has settled it.
 */
function waitForSettled(store: PrMarkerReviewStore, id: string, untilRoundEnds: boolean): Promise<void> {
  return new Promise(resolve => {
    const started = Date.now()
    const timer = setInterval(async () => {
      const review = await store.get(id)
      const latest = review?.rounds[review.rounds.length - 1]
      const busy = review?.status === 'queued'
        || (review?.status === 'running' && !!latest && !latest.endedAt && (untilRoundEnds || !latest.jobId))
      if (!review || !busy || Date.now() - started > 120_000) {
        clearInterval(timer)
        resolve()
      }
    }, 250)
  })
}

/** A CI step needs an end. Past this the round is cancelled and the run reports what it has. */
const ROUND_TIMEOUT_MS = 45 * 60_000

function waitForJob(core: Awaited<ReturnType<typeof createRunnerCore>>, jobId: string): Promise<void> {
  return new Promise(resolve => {
    const started = Date.now()
    let cancelling = false
    const timer = setInterval(async () => {
      const job = await core.stateBackend.getJob(jobId).catch(() => null)
      if (job && ['complete', 'failed', 'escalated', 'cancelled'].includes(job.status)) {
        clearInterval(timer)
        resolve()
        return
      }
      if (!cancelling && Date.now() - started > ROUND_TIMEOUT_MS) {
        cancelling = true
        await core.dispatcher.cancelJob(jobId, 'The review round timed out').catch(() => undefined)
        // A job that never reached a worker has no stop hook to report it.
        setTimeout(() => { clearInterval(timer); resolve() }, 30_000)
      }
    }, 1000)
  })
}

export function prFromArg(input: string | undefined) {
  return input ? parsePrUrl(input) : null
}
