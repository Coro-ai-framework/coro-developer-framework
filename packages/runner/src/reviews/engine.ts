import os from 'os'
import { getBaseLayerRoot } from '@coro-ai/intelligence-base'
import {
  STATUS_AWAITING_DEVELOPER_INPUT,
  STATUS_CANCELLED,
  STATUS_COMPLETE,
  STATUS_ESCALATED,
  STATUS_FAILED,
  type Job,
  type PrReview,
  type ReviewEvent,
  type RoundKind,
} from '@coro-ai/cloud-protocol'
import { MAX_RECORDED_PATHS, mergeChangedPaths } from '../jobs/changed-paths'
import { buildRelatedWork, HISTORY_LENS, type RelatedWork } from './related-work'
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
    isRoundParked: async jobId => (await ctx.stateBackend.getJob(jobId))?.status === STATUS_AWAITING_DEVELOPER_INPUT,
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
      const shortCircuit = shortCircuitFor(review, kind, round)
      if (!shortCircuit && RELATED_WORK_ROUNDS.has(kind)) {
        const related = await relatedWorkFor(ctx, scm, review, round.packet.files.map(file => file.path))
        if (related) {
          round.relatedWork = related
        } else {
          // Nothing to compare against: the history lens has no input, so it is not routed.
          round.packet.routes = round.packet.routes.filter(route => route.name !== HISTORY_LENS)
        }
      } else if (!shortCircuit) {
        round.packet.routes = round.packet.routes.filter(route => route.name !== HISTORY_LENS)
      }
      prepared.set(review.id, round)
      return shortCircuit
    },
    dispatchRound: async (review, kind, events) => {
      const round = prepared.get(review.id)
      prepared.delete(review.id)
      const roundPolicy = round?.policy ?? policy
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
          // A closing round posts nothing, so there is nothing to approve.
          interactive: roundPolicy.approveBeforePosting && kind !== 'closing',
          reviewPolicy: roundPolicy,
          prRef: review.prRef,
          prUrl: review.pr.url,
          headSha: review.pr.headSha,
          baseSha: review.pr.baseSha,
          ...(round ? { reviewPacket: round.packet, prPatchIds: round.patchIds } : {}),
          ...(round?.repoGuidance ? { repoGuidance: round.repoGuidance } : {}),
          ...(round?.description ? { prDescription: round.description } : {}),
          ...(round?.relatedWork ? { relatedWork: round.relatedWork } : {}),
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

/** Rounds that run lenses. A conversation reply or a close does not need the history. */
const RELATED_WORK_ROUNDS: ReadonlySet<RoundKind> = new Set<RoundKind>(['initial', 'incremental', 'rerequest'])

/**
 * Same-repository jobs and reviews that bear on this round. Failing to build
 * it costs the round some context, never the round: any error is logged and
 * the review proceeds without it.
 */
async function relatedWorkFor(
  ctx: RunnerContext,
  scm: ScmPluginRuntime,
  review: PrReview,
  files: string[],
): Promise<RelatedWork | null> {
  try {
    const [jobs, reviews] = await Promise.all([ctx.stateBackend.listJobs(), ctx.stateBackend.reviews.list()])
    return await buildRelatedWork({
      review,
      files,
      jobs,
      reviews,
      workingRoot: ctx.settings.paths.workingDir,
      changedPathsFor: job => changedPathsViaScm(ctx, scm, review, job),
    })
  } catch (err) {
    ctx.logger.warn({ err, reviewId: review.id }, 'could not build related work for the review round')
    return null
  }
}

const scmPathMemo = new Map<string, string[]>()

/**
 * Older jobs recorded no changed paths. The pull request they opened still
 * knows, so ask the SCM once and keep the answer on the job so no later
 * round asks again.
 */
async function changedPathsViaScm(
  ctx: RunnerContext,
  scm: ScmPluginRuntime,
  review: PrReview,
  job: Job,
): Promise<string[] | undefined> {
  if (!scm.getPrDetails) return undefined
  const mapping = job.prMappings?.[0]
  const link = (job.artifacts ?? []).find(item => item.kind === 'pr-link')?.data as Record<string, unknown> | undefined
  const prId = mapping?.prId ?? (link && Number.isFinite(Number(link['prId'])) ? Number(link['prId']) : undefined)
  const repoKey = review.prRef.repoKey
  if (prId === undefined || !repoKey) return undefined
  const jobScm = job.params?.['scm']
  if (typeof jobScm === 'string' && jobScm !== review.prRef.pluginId) return undefined

  const key = `${review.prRef.pluginId}:${repoKey}#${prId}`
  const known = scmPathMemo.get(key)
  if (known) return known
  const details = await scm.getPrDetails({
    kind: 'pull_request',
    pluginId: review.prRef.pluginId,
    repoKey,
    externalId: String(prId),
  })
  const paths = details.files.map(file => file.path).slice(0, MAX_RECORDED_PATHS)
  scmPathMemo.set(key, paths)
  const settled = new Set<string>([STATUS_COMPLETE, STATUS_FAILED, STATUS_CANCELLED, STATUS_ESCALATED])
  if (settled.has(job.status)) {
    await ctx.stateBackend
      .updateJob(job.id, { params: { ...job.params, changedPaths: mergeChangedPaths(job.params?.['changedPaths'], paths) } })
      .catch(() => undefined)
  }
  return paths
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
