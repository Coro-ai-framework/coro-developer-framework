import { describe, expect, it, vi } from 'vitest'
import { JobType, type Job, type PrReview, type ReviewEvent } from '@coro-ai/cloud-protocol'
import { MemoryReviewStore } from '../../src/reviews/store'
import { ReviewCoordinator } from '../../src/reviews/coordinator'
import { REVIEW_POLICY_DEFAULTS, reviewsConfigToPolicy, tightenPolicy } from '../../src/reviews/policy'
import { parseReviewFrontMatter } from '../../src/reviews/workspace'
import {
  REVIEW_DRAFT_KIND,
  reviewFinish,
  reviewPublish,
  reviewSubmit,
  type ReviewDraft,
} from '../../src/tools/pr-review'
import type { PhaseSignals, ToolContext } from '../../src/tools/types'

const prRef = { kind: 'pull_request' as const, pluginId: 'github', repoKey: 'acme/svc', externalId: '7', url: 'https://github.com/acme/svc/pull/7' }

function makeReview(): PrReview {
  const now = new Date().toISOString()
  return {
    id: 'rev-1',
    prRef,
    reviewer: { login: 'ada', mode: 'self' },
    status: 'running',
    pr: { title: 'Add cache', author: 'bob', baseSha: 'base', headSha: 'head1', state: 'open', draft: false, url: prRef.url },
    ledger: { findings: [] },
    rounds: [{ round: 1, jobId: 'job-1', kind: 'initial', headSha: 'head1', startedAt: now, outcome: 'no-op', summary: '', costUsd: 0 }],
    pendingEvents: [],
    totals: { rounds: 1, costUsd: 0, inputTokens: 0, outputTokens: 0 },
    createdAt: now,
    updatedAt: now,
  } as unknown as PrReview
}

function harness(opts: { phase?: string; checkpoint?: boolean } = {}) {
  const reviews = new MemoryReviewStore()
  let job = {
    id: 'job-1',
    type: JobType.PrReview,
    phase: opts.phase ?? 'review',
    status: 'reviewing',
    interactive: true,
    artifacts: [],
    params: {
      reviewId: 'rev-1',
      headSha: 'head1',
      prPatchIds: { 'a.ts': 'p1' },
      reviewPolicy: { ...REVIEW_POLICY_DEFAULTS, enabled: true, autonomy: 'full', approval: 'auto', minSeverity: 'nit' },
    },
  } as unknown as Job
  const scm = {
    submitReview: vi.fn(async () => ({ reviewId: 'gh-1', commentIds: { 'a.ts:3': 'c-1' } })),
    submitPendingReview: vi.fn(),
    resolveThread: vi.fn(async () => undefined),
  }
  const ctx = {
    job,
    settings: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    plugins: { byId: () => scm },
    stateBackend: {
      reviews,
      getJob: async () => job,
      updateJob: async (_id: string, patch: Partial<Job>) => { job = { ...job, ...patch } },
    },
    currentPhase: {
      phaseConf: { name: opts.phase ?? 'review', interactiveCheckpoint: opts.checkpoint ?? (opts.phase ?? 'review') === 'review' },
    },
  } as unknown as ToolContext
  const enterPhase = (phase: string, checkpoint: boolean) => {
    job = { ...job, phase }
    ctx.job = job
    ;(ctx as { currentPhase: unknown }).currentPhase = { phaseConf: { name: phase, interactiveCheckpoint: checkpoint } }
  }
  const draft = () => job.artifacts?.find(item => item.kind === REVIEW_DRAFT_KIND)?.data as unknown as ReviewDraft | undefined
  return { reviews, scm, ctx, draft, enterPhase, artifacts: () => job.artifacts ?? [] }
}

const comment = {
  path: 'a.ts',
  line: 3,
  side: 'RIGHT' as const,
  severity: 'major' as const,
  category: 'correctness',
  title: 'Cache never expires',
  body: 'Entries are written without a TTL.',
}

describe('review draft and publish', () => {
  it('drafts in the review phase, then posts once from the publish phase', async () => {
    const h = harness()
    await h.reviews.save(makeReview())
    const signals: PhaseSignals = {}

    const drafted = await reviewSubmit(h.ctx, { verdict: 'request_changes', body: 'One problem.', comments: [comment] }, signals) as { posted: string }
    await reviewFinish(h.ctx, { outcome: 'submitted', summary: 'Asked for a TTL.' }, signals)

    expect(drafted.posted).toBe('nothing')
    expect(h.scm.submitReview).not.toHaveBeenCalled()
    expect(h.artifacts().filter(item => item.kind === REVIEW_DRAFT_KIND)).toHaveLength(1)
    expect(h.draft()).toMatchObject({ status: 'draft', verdict: 'request_changes', headSha: 'head1', finish: { outcome: 'submitted' } })
    expect(signals.checkpointWaived).toBeUndefined()
    expect((await h.reviews.get('rev-1'))!.rounds[0]!.summary).toBe('')

    h.enterPhase('publish', false)
    await reviewPublish(h.ctx)
    await reviewPublish(h.ctx)

    expect(h.scm.submitReview).toHaveBeenCalledTimes(1)
    expect(h.scm.submitReview).toHaveBeenCalledWith(prRef, expect.objectContaining({ event: 'request_changes', commitSha: 'head1' }))
    const review = (await h.reviews.get('rev-1'))!
    expect(review.ledger.findings).toEqual([expect.objectContaining({ title: 'Cache never expires', commentId: 'c-1', status: 'open' })])
    expect(review.rounds[0]).toMatchObject({ outcome: 'submitted', summary: 'Asked for a TTL.' })
    expect(review.ledger.lastReviewedSha).toBe('head1')
    expect(h.draft()?.status).toBe('published')
  })

  it('withdraws an approval when a revision changes what will be posted', async () => {
    const h = harness()
    await h.reviews.save(makeReview())
    await reviewSubmit(h.ctx, { verdict: 'comment', body: 'First pass.', comments: [comment] }, {})

    const unchanged: PhaseSignals = {}
    await reviewSubmit(h.ctx, { verdict: 'comment', body: 'First pass.', comments: [comment] }, unchanged)
    expect(unchanged.checkpointReopened).toBeUndefined()

    const revised: PhaseSignals = {}
    await reviewSubmit(h.ctx, { verdict: 'comment', body: 'Softer wording.', comments: [] }, revised)
    expect(revised.checkpointReopened).toBeDefined()
    expect(h.artifacts().filter(item => item.kind === REVIEW_DRAFT_KIND)).toHaveLength(1)
    expect(h.draft()).toMatchObject({ body: 'Softer wording.', comments: [] })
  })

  it('withdraws an approval given before the first draft existed', async () => {
    const h = harness()
    await h.reviews.save(makeReview())

    const first: PhaseSignals = {}
    await reviewSubmit(h.ctx, { verdict: 'approve', body: 'Looks good.', comments: [] }, first)
    expect(first.checkpointReopened).toBeDefined()
  })

  it('waives the checkpoint for an empty draft, and a later submit restores it', async () => {
    const h = harness()
    await h.reviews.save(makeReview())
    const signals: PhaseSignals = {}

    await reviewFinish(h.ctx, { outcome: 'no-op', summary: 'Nothing new.' }, signals)
    expect(signals.checkpointWaived).toBeDefined()

    await reviewSubmit(h.ctx, { verdict: 'comment', body: 'Actually, one thing.', comments: [] }, signals)
    expect(signals.checkpointWaived).toBeUndefined()
  })

  it('posts immediately outside a gated phase', async () => {
    const h = harness({ phase: 'converse', checkpoint: false })
    await h.reviews.save(makeReview())

    await reviewSubmit(h.ctx, { verdict: 'comment', body: 'Follow-up.', comments: [comment] }, {})

    expect(h.scm.submitReview).toHaveBeenCalledTimes(1)
    expect(h.draft()).toBeUndefined()
  })
})

describe('approveBeforePosting policy', () => {
  it('maps from config and a repo can turn it on but never off', () => {
    expect(reviewsConfigToPolicy({ approveBeforePosting: true }).approveBeforePosting).toBe(true)
    expect(tightenPolicy(REVIEW_POLICY_DEFAULTS, { approveBeforePosting: true }).approveBeforePosting).toBe(true)
    const strict = { ...REVIEW_POLICY_DEFAULTS, approveBeforePosting: true }
    expect(tightenPolicy(strict, { approveBeforePosting: false }).approveBeforePosting).toBe(true)
    expect(parseReviewFrontMatter('---\napproveBeforePosting: true\n---\n').approveBeforePosting).toBe(true)
  })
})

describe('parked rounds and concurrency', () => {
  it('lets another pull request start while a round waits for approval', async () => {
    const store = new MemoryReviewStore()
    const dispatched: string[] = []
    const parked = new Set<string>()
    const timers: (() => void)[] = []
    const coordinator = new ReviewCoordinator({
      store,
      policy: { ...REVIEW_POLICY_DEFAULTS, enabled: true, debounceSec: 0, maxConcurrentRounds: 1 },
      reviewerLogin: 'ada',
      setTimer: fn => { timers.push(fn); return { clear() {} } },
      dispatchRound: async review => {
        const jobId = `job-${review.prRef.externalId}`
        dispatched.push(jobId)
        return { jobId }
      },
      isRoundParked: async jobId => parked.has(jobId),
    })
    const request = (externalId: string): ReviewEvent => ({
      kind: 'review-requested',
      prRef: { ...prRef, externalId, url: `https://github.com/acme/svc/pull/${externalId}` },
      at: new Date().toISOString(),
      data: { title: `PR ${externalId}`, headSha: `h${externalId}` },
      source: 'manual',
    } as ReviewEvent)
    const flush = async () => {
      while (timers.length) timers.shift()!()
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    await coordinator.ingest(request('1'))
    await flush()
    expect(dispatched).toEqual(['job-1'])

    await coordinator.ingest(request('2'))
    await flush()
    expect(dispatched).toEqual(['job-1'])

    parked.add('job-1')
    await flush()
    // The busy retry is re-armed; let it fire once more.
    await flush()
    expect(dispatched).toEqual(['job-1', 'job-2'])
    coordinator.dispose()
  })
})
