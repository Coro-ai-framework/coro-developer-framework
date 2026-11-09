import { describe, expect, it } from 'vitest'
import type { ExternalRef, PrReview, ReviewEvent, RoundKind } from '@coro-ai/cloud-protocol'
import { MemoryReviewStore } from '../../src/reviews/store'
import { ReviewCoordinator } from '../../src/reviews/coordinator'
import { REVIEW_POLICY_DEFAULTS, type ReviewPolicy } from '../../src/reviews/policy'
import { patchIdsOf, shortCircuitFor, type PreparedRound } from '../../src/reviews/prepare'

const ref: ExternalRef = { kind: 'pull_request', pluginId: 'github', repoKey: 'acme/svc', externalId: '7', url: 'https://github.com/acme/svc/pull/7' }

const settle = () => new Promise(resolve => setTimeout(resolve, 5))

function event(kind: ReviewEvent['kind'], data: Record<string, unknown> = {}, source: ReviewEvent['source'] = 'inbox-poll'): ReviewEvent {
  return { kind, prRef: ref, at: new Date().toISOString(), data: { title: 'Add rate limit', author: 'grace', ...data }, source }
}

function harness(policy: Partial<ReviewPolicy> = {}, store = new MemoryReviewStore()) {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
  const dispatched: { kind: RoundKind; jobId: string }[] = []
  const cancelled: string[] = []
  const coordinator = new ReviewCoordinator({
    store,
    policy: { ...REVIEW_POLICY_DEFAULTS, enabled: true, debounceSec: 60, ...policy },
    reviewerLogin: 'ada',
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return { clear: () => { timer.cleared = true } }
    },
    dispatchRound: async (_review, kind) => {
      const jobId = `job-${dispatched.length + 1}`
      dispatched.push({ kind, jobId })
      return { jobId }
    },
    cancelRound: async jobId => { cancelled.push(jobId) },
  })
  const live = () => timers.filter(timer => !timer.cleared)
  const fireDue = async () => {
    const due = live()
    timers.length = 0
    for (const timer of due) timer.fn()
    await settle()
  }
  const finish = (jobId: string, reviewId: string, status = 'complete') =>
    coordinator.onRoundStopped({ id: jobId, status, params: { reviewId }, tokenUsage: { totalCostUsd: 0.5 } })
  return { store, coordinator, timers, live, fireDue, finish, dispatched, cancelled }
}

describe('review coordinator scheduling', () => {
  it('does not reset the debounce when the inbox re-reports the same request', async () => {
    const h = harness()
    const first = await h.coordinator.ingest(event('review-requested', { firstSight: true }))
    expect(first?.status).toBe('queued')
    await h.coordinator.ingest(event('review-requested'))
    await h.coordinator.ingest(event('review-requested'))
    expect(h.live()).toHaveLength(1)
    await h.fireDue()
    expect(h.dispatched.map(item => item.kind)).toEqual(['initial'])
  })

  it('ignores a request the poller saw before a restart once rounds exist', async () => {
    const h = harness()
    const review = await h.coordinator.ingest(event('manual', {}, 'manual'))
    await h.fireDue()
    await h.finish('job-1', review!.id)
    await h.coordinator.ingest(event('review-requested', { firstSight: true }))
    expect(h.live()).toHaveLength(0)
  })

  it('keeps a pause that arrives while a round is running', async () => {
    const h = harness()
    const review = await h.coordinator.ingest(event('manual', {}, 'manual'))
    await h.fireDue()
    await h.coordinator.pause(review!.id)
    await h.finish('job-1', review!.id)
    const stored = await h.store.get(review!.id)
    expect(stored?.status).toBe('paused')
    expect(stored?.pauseReason).toBe('user')
    expect(stored?.totals.costUsd).toBeCloseTo(0.5)
  })

  it('stop cancels the running job and holds the review', async () => {
    const h = harness()
    const review = await h.coordinator.ingest(event('manual', {}, 'manual'))
    await h.fireDue()
    const stopped = await h.coordinator.stop(review!.id)
    expect(h.cancelled).toEqual(['job-1'])
    expect(stopped?.status).toBe('paused')
    await h.finish('job-1', review!.id, 'cancelled')
    const stored = await h.store.get(review!.id)
    expect(stored?.rounds[0]?.outcome).toBe('stopped')
    expect(stored?.status).toBe('paused')
  })

  it('a skipped review ignores new requests until started by hand', async () => {
    const h = harness()
    const review = await h.coordinator.ingest(event('review-requested'))
    await h.coordinator.skip(review!.id)
    const again = await h.coordinator.ingest(event('review-requested'))
    expect(again?.status).toBe('skipped')
    expect(h.live()).toHaveLength(0)
    const revived = await h.coordinator.ingest(event('manual', {}, 'manual'))
    expect(revived?.status).toBe('queued')
    await h.fireDue()
    expect(h.dispatched).toHaveLength(1)
  })

  it('treats a manual start on a reviewed PR as a full re-review', async () => {
    const h = harness()
    const review = await h.coordinator.ingest(event('manual', {}, 'manual'))
    await h.fireDue()
    await h.finish('job-1', review!.id)
    await h.coordinator.requestRound(review!.id)
    await h.fireDue()
    expect(h.dispatched.map(item => item.kind)).toEqual(['initial', 'rerequest'])
  })

  it('reschedules queued reviews after a restart', async () => {
    const store = new MemoryReviewStore()
    const first = harness({}, store)
    const review = await first.coordinator.ingest(event('review-requested'))
    first.coordinator.dispose()
    const second = harness({}, store)
    await second.coordinator.resumeQueued()
    expect(second.live()).toHaveLength(1)
    await second.fireDue()
    expect(second.dispatched).toHaveLength(1)
    expect((await store.get(review!.id))?.rounds[0]?.jobId).toBe('job-1')
  })

  it('pauses with a reason instead of dispatching past the per-PR budget', async () => {
    const h = harness({ budgetUsdPerPr: 0.4 })
    const review = await h.coordinator.ingest(event('manual', {}, 'manual'))
    await h.fireDue()
    await h.finish('job-1', review!.id)
    await h.coordinator.requestRound(review!.id)
    await h.fireDue()
    const stored = await h.store.get(review!.id)
    expect(h.dispatched).toHaveLength(1)
    expect(stored?.status).toBe('paused')
    expect(stored?.pauseReason).toBe('budget')
    expect(stored?.lastError).toMatch(/budget/)
  })

  it('records a failed round with the reason when the PR cannot be read', async () => {
    const store = new MemoryReviewStore()
    const coordinator = new ReviewCoordinator({
      store,
      policy: { ...REVIEW_POLICY_DEFAULTS, enabled: true, debounceSec: 0 },
      reviewerLogin: 'ada',
      setTimer: fn => { queueMicrotask(fn); return { clear() {} } },
      assess: async () => { throw new Error('Not Found') },
      dispatchRound: async () => ({ jobId: 'never' }),
    })
    const review = await coordinator.ingest(event('manual', {}, 'manual'))
    await settle()
    const stored = await store.get(review!.id)
    expect(stored?.status).toBe('failed')
    expect(stored?.lastError).toBe('Could not read the pull request: Not Found')
    expect(stored?.rounds[0]?.outcome).toBe('failed')
  })

  it('keeps the head commit the round was prepared against', async () => {
    const store = new MemoryReviewStore()
    const coordinator = new ReviewCoordinator({
      store,
      policy: { ...REVIEW_POLICY_DEFAULTS, enabled: true, debounceSec: 0 },
      reviewerLogin: 'ada',
      setTimer: fn => { queueMicrotask(fn); return { clear() {} } },
      assess: async review => {
        review.pr.headSha = 'head-from-scm'
        review.pr.baseSha = 'base-from-scm'
        return null
      },
      dispatchRound: async () => ({ jobId: 'job-1' }),
    })
    const review = await coordinator.ingest(event('manual', {}, 'manual'))
    await settle()
    const stored = await store.get(review!.id)
    expect(stored?.pr).toMatchObject({ headSha: 'head-from-scm', baseSha: 'base-from-scm' })
    expect(stored?.rounds[0]).toMatchObject({ jobId: 'job-1', headSha: 'head-from-scm' })
  })

  it('charges a round its job cost once, with lens spend only as the breakdown', async () => {
    const h = harness()
    const review = await h.coordinator.ingest(event('manual', {}, 'manual'))
    await h.fireDue()
    const running = (await h.store.get(review!.id))!
    running.rounds[0]!.lensCosts = { security: { costUsd: 0.3, inputTokens: 10, outputTokens: 1, findings: 0 } }
    await h.store.save(running)
    await h.finish('job-1', review!.id)
    const stored = await h.store.get(review!.id)
    expect(stored?.rounds[0]?.costUsd).toBeCloseTo(0.5)
    expect(stored?.totals.costUsd).toBeCloseTo(0.5)
  })

  it('records why an escalated round failed', async () => {
    const h = harness()
    const review = await h.coordinator.ingest(event('manual', {}, 'manual'))
    await h.fireDue()
    await h.coordinator.onRoundStopped({
      id: 'job-1',
      status: 'escalated',
      params: { reviewId: review!.id, roundAttempt: 2 },
      escalationMessage: 'The developer asked for a retry, not publication.',
    })
    const stored = await h.store.get(review!.id)
    expect(stored?.rounds[0]).toMatchObject({ outcome: 'failed', summary: 'The developer asked for a retry, not publication.' })
  })
})

describe('review round preparation', () => {
  const patch = (header: string) => `${header}\n context\n-old\n+new`

  it('keeps patch ids across a rebase and changes them on an edit', () => {
    const before = patchIdsOf({ files: [{ path: 'a.ts', additions: 1, deletions: 1, patch: patch('@@ -1,3 +1,3 @@') }] } as never)
    const rebased = patchIdsOf({ files: [{ path: 'a.ts', additions: 1, deletions: 1, patch: patch('@@ -40,3 +40,3 @@') }] } as never)
    const edited = patchIdsOf({ files: [{ path: 'a.ts', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+newer' }] } as never)
    expect(rebased).toEqual(before)
    expect(edited['a.ts']).not.toBe(before['a.ts'])
  })

  it('short-circuits only incremental rounds and closed PRs', () => {
    const review = {
      pr: { state: 'open', headSha: 'h2' },
      ledger: { findings: [], patchIds: { 'a.ts': 'x' } },
    } as unknown as PrReview
    const prepared = {
      patchIds: { 'a.ts': 'x' },
      packet: { files: [{ path: 'a.ts', classes: ['code'], additions: 1, deletions: 0 }] },
      policy: REVIEW_POLICY_DEFAULTS,
    } as unknown as PreparedRound
    expect(shortCircuitFor(review, 'incremental', prepared)?.kind).toBe('patch-unchanged')
    expect(shortCircuitFor(review, 'rerequest', prepared)).toBeNull()
    const merged = { ...review, pr: { ...review.pr, state: 'merged' } } as PrReview
    expect(shortCircuitFor(merged, 'initial', prepared)?.kind).toBe('out-of-scope')
  })
})
