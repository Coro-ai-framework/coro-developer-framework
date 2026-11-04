import type { Logger } from 'pino'
import type { LocalConfig } from '../config/local-config'
import { createRunnerCore, tempReviewDbPath } from '../runner/core'
import { ReviewCoordinator } from './coordinator'
import { eventsFromCi } from './ci-source'
import { PrMarkerReviewStore } from './marker-store'
import { parsePrUrl } from './id'
import type { ScmPluginRuntime } from '../plugins/types'
import { isIrrelevantConversation } from './coordinator'

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
    async () => {
      if (!scm.listReviewThreads && !scm.getPrDetails) return []
      const comments = scm.pollPr ? (await scm.pollPr(ref)).comments.map(comment => comment.body) : []
      return comments
    },
    async body => {
      await scm.submitReview!(ref, { event: 'comment', body, comments: [] })
    },
  )
  await store.hydrate()
  const policy = core.settings.reviews
  if (!policy) {
    core.stateBackend.close()
    return 1
  }
  const login = scm.whoami ? (await scm.whoami()).login : 'ci'
  let ran = false
  const coordinator = new ReviewCoordinator({
    store,
    policy: { ...policy, debounceSec: 0, enabled: true },
    reviewerLogin: login,
    identityMode: 'bot',
    setTimer: (fn) => {
      queueMicrotask(fn)
      return { clear() {} }
    },
    dispatchRound: async (review, kind) => {
      ran = true
      const job = await core.dispatcher.dispatch({
        type: 'pr-review',
        workflowPath: policy.workflowPath,
        triggerSource: 'internal',
        params: {
          reviewId: review.id,
          reviewTrigger: kind === 'closing' ? 'pr-review:closing' : kind === 'conversation' ? 'pr-review:conversation' : 'pr-review:review',
          projectContext: 'skip',
          reviewPolicy: policy,
          prUrl: review.pr.url || opts.prUrl,
          headSha: review.pr.headSha,
          description: `CI review ${ref.repoKey}#${ref.externalId}`,
          serviceName: (ref.repoKey ?? 'pr').replace(/[^\w.-]+/g, '-'),
        },
      })
      return { jobId: job.id }
    },
    assess: async (review, _kind, batch) => {
      if (isIrrelevantConversation(review, batch)) {
        return { kind: 'irrelevant-conversation', summary: 'No review needed.' }
      }
      return null
    },
    log: (msg, extra) => opts.logger.info(extra ?? {}, msg),
  })
  core.dispatcher.setRoundStoppedHandler(job => coordinator.onRoundStopped(job))
  for (const event of events) await coordinator.ingest(event)
  if (ran) {
    const review = (await store.list())[0]
    const jobId = review?.rounds[review.rounds.length - 1]?.jobId
    if (jobId) await waitForJob(core, jobId)
  }
  const review = (await store.list()).find(item => item.prRef.externalId === ref.externalId)
  const blockers = review?.ledger.findings.filter(finding => finding.status === 'open' && finding.severity === 'blocker').length ?? 0
  core.stateBackend.close()
  if (opts.failOn === 'blocker' && blockers > 0) return 2
  return 0
}

function waitForJob(core: Awaited<ReturnType<typeof createRunnerCore>>, jobId: string): Promise<void> {
  return new Promise(resolve => {
    const timer = setInterval(async () => {
      const job = await core.stateBackend.getJob(jobId)
      if (!job) return
      if (['complete', 'failed', 'escalated', 'cancelled'].includes(job.status)) {
        clearInterval(timer)
        resolve()
      }
    }, 1000)
  })
}

export function prFromArg(input: string | undefined) {
  return input ? parsePrUrl(input) : null
}
