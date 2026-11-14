import { describe, expect, it, vi } from 'vitest'
import {
  PAUSED_AWAITING_EVENT,
  WORKLIST_RECENT_RUNS,
  WORKLIST_STALE_CONVERSATION_MS,
  type Investigation,
  type Job,
  type PrReview,
  type WorkConversation,
  type WorkReview,
  type WorkRun,
} from '@coro-ai/cloud-protocol'
import {
  assembleWorklist,
  groupConversation,
  groupReview,
  groupRun,
  WorklistService,
} from '../../src/runner/worklist'
import { MemoryReviewStore } from '../../src/reviews/store'
import { toInvestigationSummary } from '../../src/state/investigation'
import type { StateBackend } from '../../src/state/backend'
import { makeMockJob } from '../mcp/fixtures'

const NOW = Date.parse('2026-06-01T12:00:00.000Z')

function job(overrides: Partial<Job> & { id: string }): Job {
  return makeMockJob({ updatedAt: '2026-06-01T10:00:00.000Z', ...overrides }) as unknown as Job
}

function investigation(overrides: Partial<Investigation> & { id: string }): Investigation {
  return {
    title: overrides.id,
    status: 'active',
    items: [],
    turns: [],
    modelChoice: { provider: '', model: '' },
    readiness: null,
    findings: null,
    turnCount: 1,
    tokens: 0,
    contextUsed: 0,
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  }
}

function review(overrides: Partial<PrReview> & { id: string }): PrReview {
  return {
    prRef: { pluginId: 'github', repoKey: 'org/repo', externalId: '7', kind: 'pull_request' },
    reviewer: { login: 'me', mode: 'self' },
    status: 'idle',
    pr: { title: 'Fix', author: 'a', baseSha: 'b', headSha: 'h', state: 'open', draft: false, url: 'https://x/pull/7' },
    ledger: { findings: [] },
    rounds: [],
    pendingEvents: [],
    totals: { rounds: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 },
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  } as PrReview
}

function run(overrides: Partial<WorkRun> & { id: string }): WorkRun {
  return {
    kind: 'run', type: 'job', workflowPath: 'workflows/job/workflow.md', title: overrides.id, repo: null,
    status: 'complete', phase: 'evaluation', currentWorkItem: null, interactive: false, costUsd: 0,
    createdAt: '2026-06-01T09:00:00.000Z', updatedAt: '2026-06-01T09:00:00.000Z',
    group: 'recent', attention: null, ...overrides,
  }
}

function conversation(overrides: Partial<WorkConversation> & { id: string }): WorkConversation {
  return {
    kind: 'conversation', title: overrides.id, status: 'dispatched', readinessState: 'ready', openQuestions: 0,
    streaming: false, pendingPermissions: 0, reviewIds: [],
    createdAt: '2026-06-01T09:00:00.000Z', updatedAt: '2026-06-01T09:00:00.000Z',
    group: 'recent', attention: null, ...overrides,
  }
}

describe('groupRun', () => {
  it.each([
    ['escalated', undefined, 'needs-you', 'escalated'],
    ['failed', undefined, 'needs-you', 'failed'],
    ['awaiting-plan-approval', undefined, 'needs-you', 'plan-approval'],
    ['awaiting-developer-input', 'developer-input: which table?', 'needs-you', 'input'],
    ['awaiting-developer-input', PAUSED_AWAITING_EVENT, 'waiting', null],
    ['awaiting-pr-merge', undefined, 'waiting', null],
    ['awaiting-children', undefined, 'waiting', null],
    ['awaiting-rate-limit', undefined, 'waiting', null],
    ['awaiting-something-new', undefined, 'waiting', null],
    ['queued', undefined, 'working', null],
    ['coding', undefined, 'working', null],
    ['linting', undefined, 'working', null],
    ['complete', undefined, 'recent', null],
    ['cancelled', undefined, 'recent', null],
  ])('%s (%s) → %s', (status, awaitingEvent, group, attention) => {
    expect(groupRun({ status, awaitingEvent })).toEqual({ group, attention })
  })
})

describe('groupConversation', () => {
  const fresh = { status: 'active' as const, updatedAt: new Date(NOW - 60_000).toISOString() }
  const idle = { streaming: false, pendingPermissions: 0 }

  it('puts a pending permission ahead of everything', () => {
    expect(groupConversation(fresh, { streaming: true, pendingPermissions: 1 }, NOW))
      .toEqual({ group: 'needs-you', attention: 'permission' })
  })

  it('is working while a turn streams', () => {
    expect(groupConversation({ ...fresh, status: 'dispatched' }, { streaming: true, pendingPermissions: 0 }, NOW).group)
      .toBe('working')
  })

  it('waits while active, and drops to recent once stale', () => {
    expect(groupConversation(fresh, idle, NOW).group).toBe('waiting')
    const stale = { status: 'active' as const, updatedAt: new Date(NOW - WORKLIST_STALE_CONVERSATION_MS - 1).toISOString() }
    expect(groupConversation(stale, idle, NOW).group).toBe('recent')
  })

  it('treats dispatched and closed conversations as recent', () => {
    expect(groupConversation({ ...fresh, status: 'dispatched' }, idle, NOW).group).toBe('recent')
    expect(groupConversation({ ...fresh, status: 'closed' }, idle, NOW).group).toBe('recent')
  })
})

describe('groupReview', () => {
  it('flags a parked draft, a held verdict and a failure', () => {
    expect(groupReview(review({ id: 'r', status: 'running' }), 'job-1').attention).toBe('review-draft')
    expect(groupReview(review({ id: 'r', status: 'awaiting-verdict' }), undefined).attention).toBe('review-verdict')
    expect(groupReview(review({ id: 'r', status: 'failed' }), undefined).attention).toBe('review-failed')
  })

  it('only holds that need a decision are needs-you', () => {
    expect(groupReview(review({ id: 'r', status: 'paused', pauseReason: 'budget' }), undefined).group).toBe('needs-you')
    expect(groupReview(review({ id: 'r', status: 'paused', pauseReason: 'max-rounds' }), undefined).group).toBe('needs-you')
    expect(groupReview(review({ id: 'r', status: 'paused', pauseReason: 'user' }), undefined).group).toBe('waiting')
    expect(groupReview(review({ id: 'r', status: 'paused', pauseReason: 'draft' }), undefined).group).toBe('waiting')
  })

  it('maps the remaining states', () => {
    expect(groupReview(review({ id: 'r', status: 'running' }), undefined).group).toBe('working')
    expect(groupReview(review({ id: 'r', status: 'queued' }), undefined).group).toBe('working')
    expect(groupReview(review({ id: 'r', status: 'idle' }), undefined).group).toBe('waiting')
    expect(groupReview(review({ id: 'r', status: 'done' }), undefined).group).toBe('recent')
    expect(groupReview(review({ id: 'r', status: 'skipped' }), undefined).group).toBe('recent')
  })
})

describe('assembleWorklist', () => {
  it('keeps a finished child of a kept conversation past the recent cap', () => {
    const many = Array.from({ length: WORKLIST_RECENT_RUNS + 5 }, (_, i) =>
      run({ id: `r${i}`, updatedAt: `2026-06-01T11:${String(i).padStart(2, '0')}:00.000Z` }))
    const oldChild = run({ id: 'old-child', investigationId: 'c1', updatedAt: '2026-05-01T00:00:00.000Z' })
    const result = assembleWorklist({
      conversations: [conversation({ id: 'c1', group: 'waiting', status: 'active' })],
      runs: [...many, oldChild],
      reviews: [],
    })
    expect(result.runs.map(r => r.id)).toContain('old-child')
    expect(result.runs.filter(r => r.id.startsWith('r'))).toHaveLength(WORKLIST_RECENT_RUNS)
  })

  it('pulls in the conversation and campaign parent of a live run', () => {
    const parent = run({ id: 'parent', investigationId: 'c-old', updatedAt: '2026-01-01T00:00:00.000Z' })
    const child = run({ id: 'child', campaignParentId: 'parent', investigationId: 'c-old', status: 'coding', group: 'working' })
    const sibling = run({ id: 'sibling', campaignParentId: 'parent', updatedAt: '2026-01-01T00:00:00.000Z' })
    const oldConversations = Array.from({ length: 40 }, (_, i) =>
      conversation({ id: `c${i}`, updatedAt: `2026-06-01T11:${String(i).padStart(2, '0')}:00.000Z` }))
    const result = assembleWorklist({
      conversations: [...oldConversations, conversation({ id: 'c-old', updatedAt: '2025-01-01T00:00:00.000Z' })],
      runs: [parent, child, sibling],
      reviews: [],
    })
    expect(result.conversations.map(c => c.id)).toContain('c-old')
    expect(result.runs.map(r => r.id).sort()).toEqual(['child', 'parent', 'sibling'])
  })

  it('keeps a review started from a kept conversation, and counts needs-you across kinds', () => {
    const rv: WorkReview = {
      kind: 'review', id: 'rv1', title: 't', prLabel: 'org/repo#1', prUrl: '', scm: 'github', prState: 'open', status: 'failed',
      openFindings: { blocker: 0, major: 0, minor: 0, nit: 0 }, rounds: 1,
      createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
      group: 'needs-you', attention: 'review-failed',
    }
    const result = assembleWorklist({
      conversations: [conversation({ id: 'c1', reviewIds: ['rv1'], group: 'needs-you', attention: 'permission' })],
      runs: [run({ id: 'esc', status: 'escalated', group: 'needs-you', attention: 'escalated' })],
      reviews: [rv],
    })
    expect(result.reviews.map(r => r.id)).toEqual(['rv1'])
    expect(result.needsYou).toBe(3)
  })
})

function fakeBackend(seed: { jobs: Job[]; investigations: Investigation[]; reviews?: PrReview[] }) {
  const jobs = new Map(seed.jobs.map(j => [j.id, j]))
  const investigations = new Map(seed.investigations.map(i => [i.id, i]))
  const reviews = new MemoryReviewStore()
  for (const r of seed.reviews ?? []) void reviews.save(r)
  const backend = {
    reviews,
    getJob: vi.fn(async (id: string) => jobs.get(id) ?? null),
    listJobs: vi.fn(async () => [...jobs.values()]),
    getInvestigation: vi.fn(async (id: string) => investigations.get(id) ?? null),
    listInvestigations: vi.fn(async ({ limit, offset }: { limit: number; offset: number }) => {
      const all = [...investigations.values()].map(toInvestigationSummary)
      return { sessions: all.slice(offset, offset + limit), total: all.length, limit, offset }
    }),
    listRecordVersions: vi.fn(async () => ({
      jobs: [...jobs.values()].map(j => ({ id: j.id, updatedAt: j.updatedAt })),
      investigations: [...investigations.values()].map(i => ({ id: i.id, updatedAt: i.updatedAt })),
    })),
  }
  return { backend, jobs, investigations }
}

describe('WorklistService', () => {
  const live = { streaming: () => false, pendingPermissions: () => 0 }

  it('re-reads only rows whose version moved', async () => {
    let now = NOW
    const { backend, jobs } = fakeBackend({
      jobs: [job({ id: 'a', status: 'coding' }), job({ id: 'b', status: 'complete' })],
      investigations: [investigation({ id: 'c' })],
    })
    const service = new WorklistService(backend as unknown as StateBackend, live, () => now)

    await service.get()
    expect(backend.getJob).toHaveBeenCalledTimes(2)

    now += 60_000
    backend.getJob.mockClear()
    backend.getInvestigation.mockClear()
    jobs.set('a', job({ id: 'a', status: 'escalated', updatedAt: '2026-06-01T11:00:00.000Z' }))
    const next = await service.get()

    expect(backend.getJob).toHaveBeenCalledTimes(1)
    expect(backend.getJob).toHaveBeenCalledWith('a')
    expect(backend.getInvestigation).not.toHaveBeenCalled()
    expect(next.runs.find(r => r.id === 'a')?.group).toBe('needs-you')
  })

  it('drops review rounds from runs and derives a parked draft from the round job', async () => {
    const round = job({ id: 'round-1', type: 'pr-review' as Job['type'], status: 'awaiting-developer-input' })
    const { backend } = fakeBackend({
      jobs: [round],
      investigations: [],
      reviews: [review({
        id: 'rv',
        status: 'running',
        rounds: [{ round: 1, jobId: 'round-1', kind: 'initial', headSha: 'h', startedAt: '2026-06-01T10:00:00.000Z', outcome: 'submitted', summary: '', costUsd: 0 }],
      } as Partial<PrReview> & { id: string })],
    })
    const service = new WorklistService(backend as unknown as StateBackend, live, () => NOW)
    const result = await service.get()
    expect(result.runs).toEqual([])
    expect(result.reviews[0]).toMatchObject({ awaitingApprovalJobId: 'round-1', group: 'needs-you', attention: 'review-draft' })
  })

  it('falls back to full listing when the backend cannot list versions', async () => {
    const { backend } = fakeBackend({ jobs: [job({ id: 'a' })], investigations: [investigation({ id: 'c' })] })
    const { listRecordVersions: _omit, ...withoutVersions } = backend
    const service = new WorklistService(withoutVersions as unknown as StateBackend, live, () => NOW)
    const result = await service.get()
    expect(backend.listJobs).toHaveBeenCalled()
    expect(result.runs.map(r => r.id)).toEqual(['a'])
    expect(result.conversations.map(c => c.id)).toEqual(['c'])
  })

  it('shares one build between polls that arrive together', async () => {
    const { backend } = fakeBackend({ jobs: [job({ id: 'a' })], investigations: [] })
    const service = new WorklistService(backend as unknown as StateBackend, live, () => NOW)
    await Promise.all([service.get(), service.get(), service.get()])
    expect(backend.listRecordVersions).toHaveBeenCalledTimes(1)
  })
})

describe('toJobListView', () => {
  it('drops the heavy fields and keeps what lists read', async () => {
    const { toJobListView } = await import('../../src/runner/job-list-view')
    const full = job({
      id: 'heavy',
      insights: [{ phase: 'coding', category: 'x', summary: 's', detail: 'd' }],
      artifacts: [{ id: 'a', phase: 'coding', kind: 'k', title: 't', data: {}, createdBy: 'c', createdAt: '' }],
      params: { serviceName: 'svc', investigationId: 'c1' },
      tokenUsage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalCostUsd: 2 },
    } as Partial<Job> & { id: string })
    const slim = toJobListView(full)
    expect(slim.insights).toEqual([])
    expect(slim.artifacts).toEqual([])
    expect(slim.params).toEqual(full.params)
    expect(slim.tokenUsage?.totalCostUsd).toBe(2)
  })
})
