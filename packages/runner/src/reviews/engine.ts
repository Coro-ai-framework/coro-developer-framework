import path from 'path'
import os from 'os'
import type { Job, PrReview, ReviewEvent, RoundKind } from '@coro-ai/cloud-protocol'
import type { Dispatcher } from '../jobs/dispatcher'
import type { RunnerContext } from '../jobs/runner'
import type { LocalConfig } from '../config/local-config'
import { ActivityPoller } from './activity-poller'
import { ReviewCoordinator } from './coordinator'
import { isIrrelevantConversation } from './coordinator'
import { InboxPoller } from './inbox-poller'
import { isOutOfScopeDelta, patchUnchanged, type PacketFile } from './packet'
import { reviewsConfigToPolicy, type ReviewPolicy } from './policy'
import { createWebhookReviewSink } from './webhook-source'
import type { ScmPluginRuntime } from '../plugins/types'

export interface ReviewRuntime {
  coordinator: ReviewCoordinator
  stop(): void
}

let active: ReviewRuntime | null = null

export function getReviewRuntime(): ReviewRuntime | null {
  return active
}

/**
 * Apply the reviews block from disk to the live runner. Enabling starts
 * the inbox; disabling stops it. Saving the setting is not enough on its
 * own — the process that is already up has to be told.
 */
export async function syncReviewEngine(
  ctx: RunnerContext,
  dispatcher: Dispatcher,
  config: LocalConfig,
): Promise<ReviewRuntime | null> {
  ctx.settings.reviews = reviewsConfigToPolicy(config.reviews)
  active?.stop()
  if (!ctx.settings.reviews.enabled) return null
  return startReviewEngine(ctx, dispatcher, config)
}

/**
 * Starts the shared review engine when `reviews.enabled`. Pollers run for
 * `poll` and `both`. `webhook` registers the unmatched-event sink and
 * skips the pollers. Hybrid and local share this; state stays on the
 * runner's ReviewStore.
 */
export async function startReviewEngine(
  ctx: RunnerContext,
  dispatcher: Dispatcher,
  config: LocalConfig,
): Promise<ReviewRuntime | null> {
  const policy = ctx.settings.reviews
  if (!policy?.enabled) return null
  await ctx.stateBackend.reviews.initialize?.()

  const login = await reviewerLogin(ctx, policy)
  const coordinator = new ReviewCoordinator({
    store: ctx.stateBackend.reviews,
    policy,
    reviewerLogin: login,
    identityMode: policy.identity,
    log: (msg, extra) => ctx.logger.info(extra ?? {}, msg),
    dispatchRound: (review, kind, events) => dispatchRound(ctx, dispatcher, policy, review, kind, events),
    assess: async (review, _kind, events) => {
      if (isIrrelevantConversation(review, events)) {
        return { kind: 'irrelevant-conversation', summary: 'Conversation did not need a review.' }
      }
      const patchIds = events.map(event => event.data['patchIds']).find(value => value && typeof value === 'object') as Record<string, string> | undefined
      if (patchIds && patchUnchanged(review.ledger.patchIds, patchIds)) {
        return { kind: 'patch-unchanged', summary: 'Diff patch ids are unchanged.' }
      }
      const files = events.map(event => event.data['files']).find(Array.isArray) as PacketFile[] | undefined
      if (files && isOutOfScopeDelta(files, policy.ignorePaths)) {
        return { kind: 'out-of-scope', summary: 'Changed files are generated, vendored, or ignored.' }
      }
      return null
    },
    spendTodayUsd: async () => {
      const reviews = await ctx.stateBackend.reviews.list()
      const day = new Date().toISOString().slice(0, 10)
      return reviews.reduce((sum, review) => sum + (review.spendDay?.day === day ? review.spendDay.usd : 0), 0)
    },
  })

  dispatcher.setRoundStoppedHandler(async (job: Job) => {
    await coordinator.onRoundStopped(job)
  })

  const pollers: { stop(): void }[] = []
  if (policy.eventSource === 'poll' || policy.eventSource === 'both') {
    const inbox = new InboxPoller(ctx.plugins, policy, ctx.logger)
    const activity = new ActivityPoller(ctx.stateBackend.reviews, ctx.plugins, policy, ctx.logger)
    const sink = (event: ReviewEvent) => coordinator.ingest(event).then(() => undefined)
    inbox.start(sink)
    activity.start(sink)
    pollers.push(inbox, activity)
  }
  if (policy.eventSource === 'webhook' || policy.eventSource === 'both') {
    dispatcher.setUnmatchedPluginEventSink(createWebhookReviewSink(coordinator, login))
  }

  await coordinator.reconcileRunning(async jobId => {
    const job = await ctx.stateBackend.getJob(jobId)
    return job?.status ?? null
  })

  const runtime: ReviewRuntime = {
    coordinator,
    stop() {
      for (const poller of pollers) poller.stop()
      dispatcher.setRoundStoppedHandler(undefined)
      dispatcher.setUnmatchedPluginEventSink(undefined)
      if (active === runtime) active = null
    },
  }
  active = runtime
  ctx.logger.info({ login, eventSource: policy.eventSource }, 'PR review engine started')
  void config
  return runtime
}

async function reviewerLogin(ctx: RunnerContext, policy: ReviewPolicy): Promise<string> {
  for (const pluginId of policy.scms) {
    const runtime = ctx.plugins.byId(pluginId) as ScmPluginRuntime | undefined
    if (!runtime?.whoami) continue
    try {
      const identity = await runtime.whoami()
      if (identity.login) return identity.login
    } catch (err) {
      ctx.logger.warn({ err, pluginId }, 'review whoami failed')
    }
  }
  return os.userInfo().username
}

async function dispatchRound(
  ctx: RunnerContext,
  dispatcher: Dispatcher,
  policy: ReviewPolicy,
  review: PrReview,
  kind: RoundKind,
  events: ReviewEvent[],
): Promise<{ jobId: string }> {
  const job = await dispatcher.dispatch({
    type: 'pr-review',
    workflowPath: policy.workflowPath,
    triggerSource: 'internal',
    params: {
      reviewId: review.id,
      reviewTrigger: kind === 'closing' ? 'pr-review:closing' : kind === 'conversation' || kind === 'command' ? 'pr-review:conversation' : 'pr-review:review',
      projectContext: 'skip',
      reviewPolicy: policy,
      prRef: review.prRef,
      prUrl: review.pr.url,
      headSha: review.pr.headSha,
      description: `Review ${review.pr.url || review.prRef.externalId} (${kind})`,
      serviceName: (review.prRef.repoKey ?? 'pr').replace(/[^\w.-]+/g, '-'),
      triggeringEvents: events.map(event => ({ kind: event.kind, at: event.at })),
      repoCheckoutAbsDir: path.join(ctx.settings.paths.workingDir, 'reviews', review.id, 'base'),
    },
  })
  return { jobId: job.id }
}

export function reviewCacheRoot(workingDir: string): string {
  return path.join(workingDir, 'review-refs')
}
