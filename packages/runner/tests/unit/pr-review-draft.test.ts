import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
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
  reviewRelatedWork,
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

function harness(opts: { phase?: string; checkpoint?: boolean; policy?: Partial<typeof REVIEW_POLICY_DEFAULTS> } = {}) {
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
      reviewPolicy: { ...REVIEW_POLICY_DEFAULTS, enabled: true, autonomy: 'full', approval: 'auto', minSeverity: 'nit', ...opts.policy },
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
  const enterPhase = (phase: string, checkpoint: boolean, extra: Record<string, unknown> = {}) => {
    job = { ...job, phase }
    ctx.job = job
    ;(ctx as { currentPhase: unknown }).currentPhase = { phaseConf: { name: phase, interactiveCheckpoint: checkpoint }, ...extra }
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

  it('posts the verdict the developer approved instead of holding it for a second approval', async () => {
    const h = harness({ policy: { autonomy: 'comment', approval: 'recommend' } })
    await h.reviews.save(makeReview())
    await reviewSubmit(h.ctx, { verdict: 'approve', body: 'Looks good.', comments: [] }, {})
    expect(h.draft()?.posts).toBe('verdict')

    h.enterPhase('publish', false, { enteredByApproval: { fromPhase: 'review', at: '2026-11-12T10:00:00.000Z' } })
    await reviewPublish(h.ctx)

    expect(h.scm.submitReview).toHaveBeenCalledWith(prRef, expect.objectContaining({ event: 'approve' }))
    expect((await h.reviews.get('rev-1'))!.pendingVerdict).toBeUndefined()
    expect(h.draft()).toMatchObject({ status: 'published', approvedAt: '2026-11-12T10:00:00.000Z' })
  })

  it('still holds the verdict when nobody approved the draft', async () => {
    const h = harness({ policy: { autonomy: 'comment', approval: 'recommend' } })
    await h.reviews.save(makeReview())
    await reviewSubmit(h.ctx, { verdict: 'approve', body: 'Looks good.', comments: [] }, {})

    h.enterPhase('publish', false)
    await reviewPublish(h.ctx)

    expect(h.scm.submitReview).toHaveBeenCalledWith(prRef, expect.objectContaining({ event: 'comment' }))
    expect((await h.reviews.get('rev-1'))!.pendingVerdict).toBeDefined()
  })

  it('refuses a review that cites Coro related work the author never saw', async () => {
    const h = harness()
    await h.reviews.save(makeReview())
    h.ctx.job.params['prDescription'] = 'Fixes WS-1 as requested.'
    h.ctx.job.params['relatedWork'] = {
      builtAt: '', windowDays: 60, priorFindings: [], reviews: [],
      jobs: [{ id: 'svc-job-42', role: 'overlap', ticket: 'WS-6876', prUrl: 'https://github.com/acme/svc/pull/8', overlapPaths: ['a.ts'] }],
    }

    await expect(reviewSubmit(h.ctx, { verdict: 'comment', body: 'Related work: WS-6876 (PR #8) touched this.', comments: [] }, {}))
      .rejects.toThrow('WS-6876')
    await expect(reviewSubmit(h.ctx, { verdict: 'comment', body: 'x', comments: [{ ...comment, body: 'Job svc-job-42 kept the retry.' }] }, {}))
      .rejects.toThrow('svc-job-42')
    await reviewSubmit(h.ctx, { verdict: 'comment', body: 'This fixes WS-1; one problem below.', comments: [comment] }, {})
    expect(h.draft()?.body).toContain('WS-1')
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

  it('drops a comment that repeats an open or declined finding, even reworded', async () => {
    const h = harness()
    const review = makeReview()
    review.ledger.findings.push(
      { id: 'f_open', fingerprint: 'x1', severity: 'major', category: 'correctness', lens: 'correctness', path: 'a.ts', line: 3, title: 'Cache entries never expire', status: 'open', raisedInRound: 1, lastTouchedRound: 1 },
      { id: 'f_decl', fingerprint: 'x2', severity: 'minor', category: 'design', lens: 'design', path: 'a.ts', line: 40, title: 'Rename the helper', status: 'declined', raisedInRound: 1, lastTouchedRound: 1 },
    )
    await h.reviews.save(review)

    const result = await reviewSubmit(h.ctx, {
      verdict: 'comment',
      body: 'x',
      comments: [
        { ...comment, title: 'The cache entries never expire' },
        { ...comment, line: 41, category: 'design', severity: 'minor', title: 'Rename helper function' },
        { ...comment, line: 4, title: 'Unrelated problem with the lock', findingId: undefined },
      ],
    }, {}) as { comments: number; dropped: number }

    expect(result.dropped).toBe(2)
    expect(h.draft()?.comments.map(item => item.title)).toEqual(['Unrelated problem with the lock'])
  })

  it('moves a comment on a line the diff does not show into the review body', async () => {
    const h = harness()
    await h.reviews.save(makeReview())
    const dir = await mkdtemp(path.join(tmpdir(), 'coro-draft-'))
    await mkdir(path.join(dir, 'pr'), { recursive: true })
    await writeFile(path.join(dir, 'pr', 'diff.patch'), [
      'diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,3 @@', ' one', '+two', ' three',
    ].join('\n'), 'utf8')
    ;(h.ctx.currentPhase as unknown as { workingDir: string }).workingDir = dir

    const inside = { ...comment, line: 2, title: 'On a changed line' }
    const outside = { ...comment, line: 90, title: 'Far from the change' }
    const first = await reviewSubmit(h.ctx, { verdict: 'comment', body: 'Summary.', comments: [inside, outside] }, {}) as { movedToBody?: number }
    expect(first.movedToBody).toBe(1)
    expect(h.draft()?.comments.map(item => item.title)).toEqual(['On a changed line'])
    expect(h.draft()?.body).toContain('Also noticed, outside the changed lines')
    expect(h.draft()?.body).toContain('a.ts:90')

    await reviewSubmit(h.ctx, { verdict: 'comment', body: h.draft()!.body, comments: [inside, outside] }, {})
    expect(h.draft()?.body.match(/Also noticed/g)).toHaveLength(1)

    await rm(dir, { recursive: true, force: true })
  })

  it('records the raising lens on the posted finding and its round stats', async () => {
    const h = harness({ phase: 'converse', checkpoint: false })
    await h.reviews.save(makeReview())

    await reviewSubmit(h.ctx, { verdict: 'comment', body: 'x', comments: [{ ...comment, lens: 'security' }] }, {})

    const review = (await h.reviews.get('rev-1'))!
    expect(review.ledger.findings[0]?.lens).toBe('security')
    expect(review.rounds[0]?.lensCosts?.['security']?.posted).toBe(1)
  })

  it('opens only the related work this round was shown', async () => {
    const h = harness()
    await h.reviews.save(makeReview())
    const earlier = { ...makeReview(), id: 'rev-0' } as PrReview
    earlier.ledger.findings.push({ id: 'f_old', fingerprint: 'o', severity: 'major', category: 'design', lens: 'design', path: 'a.ts', title: 'Old finding', status: 'declined', raisedInRound: 1, lastTouchedRound: 1 })
    await h.reviews.save(earlier)
    h.ctx.job.params['relatedWork'] = { builtAt: '', windowDays: 60, jobs: [], priorFindings: [], reviews: [{ reviewId: 'rev-0', prTitle: 'Older', prState: 'merged', overlapPaths: ['a.ts'], findings: [] }] }

    await expect(reviewRelatedWork(h.ctx, { kind: 'review', id: 'rev-unrelated' })).rejects.toThrow('not part of this round')
    await expect(reviewRelatedWork(h.ctx, { kind: 'job', id: 'job-9' })).rejects.toThrow('not part of this round')
    const opened = await reviewRelatedWork(h.ctx, { kind: 'review', id: 'rev-0' }) as { findings: { title: string }[] }
    expect(opened.findings.map(item => item.title)).toEqual(['Old finding'])
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
