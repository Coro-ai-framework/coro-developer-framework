import os from 'os'
import { getBaseLayerRoot } from '@coro-ai/intelligence-base'
import type { Job, PrReview, ReviewEvent, RoundKind } from '@coro-ai/cloud-protocol'
import type { Dispatcher } from '../jobs/dispatcher'
import type { RunnerContext } from '../jobs/runner'
import type { LocalConfig } from '../config/local-config'
import { loadWorkflowConfigFromRoots } from '../workflow-parser'
import { ActivityPoller } from './activity-poller'
import { ReviewCoordinator, isIrrelevantConversation, type ShortCircuitDecision } from './coordinator'
import { InboxPoller, type InboxStatus } from './inbox-poller'
import { prepareRound, shortCircuitFor, type PreparedRound } from './prepare'
import { reviewsConfigToPolicy, type ReviewPolicy } from './policy'
import { createWebhookReviewSink } from './webhook-source'
import type { ScmPluginRuntime } from '../plugins/types'

export interface ReviewEngineStatus {
  enabled: boolean
  running: boolean
  login?: string
  identity?: ReviewPolicy['identity']
  eventSource?: ReviewPolicy['eventSource']
  scms: string[]
  inboxIntervalSec?: number
  inbox?: InboxStatus
  startedAt?: string
}

export interface ReviewRuntime {
  coordinator: ReviewCoordinator
  status(): ReviewEngineStatus
  /** Poll the inbox now instead of waiting for the next interval. */
  pollInbox(): Promise<void>
  stop(): void
}

let active: ReviewRuntime | null = null
let transition: Promise<unknown> = Promise.resolve()

export function getReviewRuntime(): ReviewRuntime | null {
  return active
}

/**
 * Apply the reviews block from disk to the live runner. Enabling starts
 * the inbox; disabling stops it. Saving the setting is not enough on its
 * own — the process that is already up has to be told.
 *
 * Starting awaits the SCM, so two overlapping calls would each build an
 * engine and leak the first one's pollers. Calls run one after another.
 */
export function syncReviewEngine(
  ctx: RunnerContext,
  dispatcher: Dispatcher,
  config: LocalConfig,
): Promise<ReviewRuntime | null> {
  const next = transition.catch(() => undefined).then(async () => {
    ctx.settings.reviews = reviewsConfigToPolicy(config.reviews)
    active?.stop()
    if (!ctx.settings.reviews.enabled) return null
    return startReviewEngine(ctx, dispatcher, config)
  })
  transition = next
  return next
}

/** Start the engine unless one is already up or another call is starting it. */
export function ensureReviewEngine(
  ctx: RunnerContext,
  dispatcher: Dispatcher,
  config: LocalConfig,
): Promise<ReviewRuntime | null> {
  const next = transition.catch(() => undefined).then(async () => {
    if (active) return active
    ctx.settings.reviews = reviewsConfigToPolicy(config.reviews)
    if (!ctx.settings.reviews.enabled) return null
    return startReviewEngine(ctx, dispatcher, config)
  })
  transition = next
  return next
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
  _config: LocalConfig,
): Promise<ReviewRuntime | null> {
  const policy = ctx.settings.reviews
  if (!policy?.enabled) return null
  active?.stop()
  await ctx.stateBackend.reviews.initialize?.()

  const login = await reviewerLogin(ctx, policy)
  const pipeline = await createRoundPipeline(ctx, dispatcher, policy)
  const coordinator = new ReviewCoordinator({
    store: ctx.stateBackend.reviews,
    policy,
    reviewerLogin: login,
    identityMode: policy.identity,
    log: (msg, extra) => ctx.logger.info(extra ?? {}, msg),
    dispatchRound: pipeline.dispatchRound,
    assess: pipeline.assess,
    cancelRound: async jobId => {
      await dispatcher.cancelJob(jobId, 'Stopped from the review')
      // A job that is not on a worker never reaches the dispatcher's stop hook.
      if (dispatcher.isJobActive(jobId)) return
      const job = await ctx.stateBackend.getJob(jobId)
      if (job?.status === 'cancelled') {
        setTimeout(() => void coordinator.onRoundStopped(job).catch(() => undefined), 0)
      }
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
  let inbox: InboxPoller | undefined
  const sink = (event: ReviewEvent) => coordinator.ingest(event).then(() => undefined)
  if (policy.eventSource === 'poll' || policy.eventSource === 'both') {
    inbox = new InboxPoller(ctx.plugins, policy, ctx.logger)
    const activity = new ActivityPoller(ctx.stateBackend.reviews, ctx.plugins, policy, ctx.logger)
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
  await coordinator.resumeQueued()

  const startedAt = new Date().toISOString()
  const runtime: ReviewRuntime = {
    coordinator,
    status: () => ({
      enabled: true,
      running: true,
      login,
      identity: policy.identity,
      eventSource: policy.eventSource,
      scms: [...policy.scms],
      inboxIntervalSec: policy.inboxIntervalSec,
      ...(inbox ? { inbox: inbox.status() } : {}),
      startedAt,
    }),
    pollInbox: async () => {
      if (!inbox) throw new Error('The inbox is off because reviews listen for webhooks only.')
      await inbox.pollNow()
    },
    stop() {
      for (const poller of pollers) poller.stop()
      coordinator.dispose()
      dispatcher.setRoundStoppedHandler(undefined)
      dispatcher.setUnmatchedPluginEventSink(undefined)
      if (active === runtime) active = null
    },
  }
  active = runtime
  ctx.logger.info({ login, eventSource: policy.eventSource }, 'PR review engine started')
  return runtime
}

export interface RoundPipeline {
  assess: (review: PrReview, kind: RoundKind, events: ReviewEvent[]) => Promise<ShortCircuitDecision | null>
  dispatchRound: (review: PrReview, kind: RoundKind, events: ReviewEvent[]) => Promise<{ jobId: string }>
}

/**
 * What happens between "a round is due" and "a job exists". Shared by the
 * daemon and `--once` so both review the same packet under the same policy.
 * `assess` reads the PR through the SCM; `dispatchRound` uses what it read.
 */
export async function createRoundPipeline(
  ctx: RunnerContext,
  dispatcher: Dispatcher,
  policy: ReviewPolicy,
  extraParams: Record<string, unknown> = {},
): Promise<RoundPipeline> {
  const lenses = await workflowLenses(ctx, policy)
  const prepared = new Map<string, PreparedRound>()

  return {
    assess: async (review, kind, events) => {
      prepared.delete(review.id)
      if (isIrrelevantConversation(review, events)) {
        return { kind: 'irrelevant-conversation', summary: 'Conversation did not need a review.' }
      }
      if (kind === 'closing') return null
      const scm = ctx.plugins.byId(review.prRef.pluginId) as ScmPluginRuntime | undefined
      if (!scm) throw new Error(`No ${review.prRef.pluginId} plugin is configured.`)
      const round = await prepareRound({ scm, review, policy, lenses })
      prepared.set(review.id, round)
      return shortCircuitFor(review, kind, round)
    },
    dispatchRound: async (review, kind, events) => {
      const round = prepared.get(review.id)
      prepared.delete(review.id)
      const job = await dispatcher.dispatch({
        type: 'pr-review',
        workflowPath: policy.workflowPath,
        triggerSource: 'internal',
        params: {
          reviewId: review.id,
          reviewTrigger: kind === 'closing' ? 'pr-review:closing' : kind === 'conversation' || kind === 'command' ? 'pr-review:conversation' : 'pr-review:review',
          roundKind: kind,
          roundAttempt: events.some(event => event.data['retry'] === true) ? 2 : 1,
          projectContext: 'skip',
          reviewPolicy: round?.policy ?? policy,
          prRef: review.prRef,
          prUrl: review.pr.url,
          headSha: review.pr.headSha,
          baseSha: review.pr.baseSha,
          ...(round ? { reviewPacket: round.packet, prPatchIds: round.patchIds } : {}),
          ...(round?.repoGuidance ? { repoGuidance: round.repoGuidance } : {}),
          description: `Review ${review.pr.title || review.pr.url || review.prRef.externalId} (${kind})`,
          serviceName: (review.prRef.repoKey ?? 'pr').replace(/[^\w.-]+/g, '-'),
          triggeringEvents: events.map(event => ({ kind: event.kind, at: event.at })),
          ...extraParams,
        },
      })
      return { jobId: job.id }
    },
  }
}

async function workflowLenses(ctx: RunnerContext, policy: ReviewPolicy): Promise<{ name: string; when?: string[] }[]> {
  const resolved = await loadWorkflowConfigFromRoots(
    policy.workflowPath,
    [ctx.settings.paths.coroIntelligenceDir, getBaseLayerRoot()],
    ctx.logger,
  )
  const review = resolved?.config.phases.find(phase => (phase.lenses?.length ?? 0) > 0)
  return (review?.lenses ?? []).map(lens => ({ name: lens.name, ...(lens.when ? { when: lens.when } : {}) }))
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
