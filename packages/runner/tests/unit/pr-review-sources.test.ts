import { describe, expect, it } from 'vitest'
import type { ExternalRef, InboundEvent, ReviewEvent, RoundKind } from '@coro-ai/cloud-protocol'
import { reviewMarker } from '@coro-ai/cloud-protocol'
import { MemoryReviewStore } from '../../src/reviews/store'
import { ReviewCoordinator } from '../../src/reviews/coordinator'
import { REVIEW_POLICY_DEFAULTS } from '../../src/reviews/policy'
import { createWebhookReviewSink } from '../../src/reviews/webhook-source'
import { deltaEventData } from '../../src/reviews/activity-poller'
import { diffPrSnapshot } from '../../src/reviews/pr-change-detector'
import { lensToolDecision } from '../../src/tools/pr-review'

const ref: ExternalRef = { kind: 'pull_request', pluginId: 'github', repoKey: 'acme/svc', externalId: '7', url: 'https://github.com/acme/svc/pull/7' }
const settle = () => new Promise(resolve => setTimeout(resolve, 5))

function harness() {
  const store = new MemoryReviewStore()
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
  const dispatched: { kind: RoundKind; jobId: string }[] = []
  const ingested: ReviewEvent[] = []
  let clock = 1_000_000
  const coordinator = new ReviewCoordinator({
    store,
    policy: { ...REVIEW_POLICY_DEFAULTS, enabled: true, debounceSec: 60 },
    reviewerLogin: 'ada',
    now: () => clock,
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
  })
  const original = coordinator.ingest.bind(coordinator)
  coordinator.ingest = (event: ReviewEvent) => {
    ingested.push(event)
    return original(event)
  }
  const live = () => timers.filter(timer => !timer.cleared)
  const fireDue = async () => {
    const due = live()
    timers.length = 0
    for (const timer of due) timer.fn()
    await settle()
  }
  return { store, coordinator, live, fireDue, dispatched, ingested, tick: (ms: number) => { clock += ms } }
}

function inbound(eventKey: string, payload: Record<string, unknown>, repoKey = 'svc'): InboundEvent {
  return {
    eventKey,
    ref: { kind: 'pull_request', pluginId: 'github', repoKey, externalId: '7' },
    payload,
    receivedAt: new Date().toISOString(),
  } as InboundEvent
}

describe('webhook review sink', () => {
  const repository = { name: 'svc', full_name: 'acme/svc' }

  it('drops a review request for someone else and keeps one for the runner', async () => {
    const h = harness()
    const sink = createWebhookReviewSink(h.coordinator, 'ada')
    await sink(inbound('pr.review_requested', { repository, requested_reviewer: { login: 'bob' }, pull_request: { number: 7 } }))
    expect(h.ingested).toHaveLength(0)
    await sink(inbound('pr.review_requested', { repository, requested_reviewer: { login: 'Ada' }, pull_request: { number: 7 } }))
    expect(h.ingested).toHaveLength(1)
  })

  it('keys webhook reviews by owner/repo so they match the inbox', async () => {
    const h = harness()
    const sink = createWebhookReviewSink(h.coordinator, 'ada')
    await sink(inbound('pr.review_requested', {
      repository,
      requested_reviewer: { login: 'ada' },
      pull_request: { number: 7, title: 'Add rate limit', head: { sha: 'abc123' }, user: { login: 'grace' } },
    }))
    const [review] = await h.store.list()
    expect(review?.prRef.repoKey).toBe('acme/svc')
    expect(review?.pr.headSha).toBe('abc123')
    expect(review?.pr.author).toBe('grace')
  })

  it('carries comment text and author, and drops Coro\'s own comments', async () => {
    const h = harness()
    const sink = createWebhookReviewSink(h.coordinator, 'ada')
    await sink(inbound('pr.commented', { repository, comment: { id: 55, body: '@coro pause', user: { login: 'grace' } } }))
    expect(h.ingested[0]?.data['body']).toBe('@coro pause')
    expect(h.ingested[0]?.actor).toBe('grace')
    expect(h.ingested[0]?.data['commentId']).toBe('55')
  })
})

describe('activity poller events', () => {
  it('turns a detector comment into body, comment id, and actor', () => {
    const [delta] = diffPrSnapshot(
      { state: 'open', approvalCount: 0, commentCount: 0 },
      { state: 'open', approvalCount: 0, commentCount: 1 },
      [{ id: '9', body: `Summary\n\n${reviewMarker('rev_1')}`, createdAt: '', author: 'ada' }],
    )
    const mapped = deltaEventData(delta!.payload)
    expect(mapped.data['body']).toContain('coro-review')
    expect(mapped.data['commentId']).toBe('9')
    expect(mapped.actor).toBe('ada')
  })

  it('lets the coordinator recognise its own polled summary', async () => {
    const h = harness()
    await h.coordinator.ingest({ kind: 'manual', prRef: ref, at: '', data: {}, source: 'manual' })
    await h.fireDue()
    const { data, actor } = deltaEventData({ comment: { id: '9', content: { raw: `Done\n\n${reviewMarker('x')}` }, user: { display_name: 'ada' } } })
    const result = await h.coordinator.ingest({ kind: 'comment', prRef: ref, at: '', data, ...(actor ? { actor } : {}), source: 'activity-poll' })
    expect(result).toBeNull()
  })
})

describe('coordinator debounce window', () => {
  it('does not push a due round later when more activity arrives', async () => {
    const h = harness()
    const review = await h.coordinator.ingest({ kind: 'manual', prRef: ref, at: '', data: {}, source: 'manual' })
    await h.fireDue()
    await h.coordinator.onRoundStopped({ id: 'job-1', status: 'complete', params: { reviewId: review!.id } })
    await h.coordinator.ingest({ kind: 'commits-pushed', prRef: ref, at: '', data: { headSha: 'b' }, source: 'activity-poll' })
    const due = h.coordinator.nextRoundAt(review!.id)
    h.tick(30_000)
    await h.coordinator.ingest({ kind: 'commits-pushed', prRef: ref, at: '', data: { headSha: 'c' }, source: 'activity-poll' })
    expect(h.coordinator.nextRoundAt(review!.id)).toBe(due)
    expect(h.live()).toHaveLength(1)
  })

  it('retries a failed round once, then reports it failed', async () => {
    const h = harness()
    const review = await h.coordinator.ingest({ kind: 'manual', prRef: ref, at: '', data: {}, source: 'manual' })
    await h.fireDue()
    await h.coordinator.onRoundStopped({ id: 'job-1', status: 'failed', params: { reviewId: review!.id, roundAttempt: 1 } })
    expect((await h.store.get(review!.id))?.status).toBe('queued')
    await h.fireDue()
    expect(h.dispatched).toHaveLength(2)
    await h.coordinator.onRoundStopped({ id: 'job-2', status: 'failed', params: { reviewId: review!.id, roundAttempt: 2 } })
    const stored = await h.store.get(review!.id)
    expect(stored?.status).toBe('failed')
    expect(h.live()).toHaveLength(0)
  })
})

describe('lens tool gate', () => {
  const mcp = { allowTools: ['mcp__arch__*'], denyTools: ['mcp__arch__export_*'] }

  it('lets read tools through and refuses denied or write-shaped ones', () => {
    expect(lensToolDecision('Read', mcp).allow).toBe(true)
    expect(lensToolDecision('mcp__coro__review_get_context', mcp).allow).toBe(true)
    expect(lensToolDecision('mcp__arch__get_service', mcp).allow).toBe(true)
    expect(lensToolDecision('mcp__arch__export_graph', mcp).allow).toBe(false)
    expect(lensToolDecision('mcp__arch__update_owner', mcp).allow).toBe(false)
  })

  it('allows a write-shaped tool only by its exact name', () => {
    expect(lensToolDecision('mcp__arch__create_snapshot', { allowTools: ['mcp__arch__create_snapshot'], denyTools: [] }).allow).toBe(true)
  })
})
