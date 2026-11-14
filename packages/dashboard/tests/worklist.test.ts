import { describe, expect, it } from 'vitest'
import {
  activeItemKey,
  buildThreads,
  compactAge,
  countInGroup,
  conversationHref,
  filterThreads,
  groupThreads,
  itemDetail,
  itemHref,
  parseInspector,
  runWaitingReason,
  withInspector,
  type WorkConversation,
  type Worklist,
  type WorkReview,
  type WorkRun,
} from '../src/lib/worklist'

function conversation(id: string, extra: Partial<WorkConversation> = {}): WorkConversation {
  return {
    kind: 'conversation', id, title: id, status: 'dispatched', readinessState: 'ready', openQuestions: 0,
    streaming: false, pendingPermissions: 0, reviewIds: [],
    createdAt: '2026-06-01T09:00:00.000Z', updatedAt: '2026-06-01T09:00:00.000Z',
    group: 'recent', attention: null, ...extra,
  }
}

function run(id: string, extra: Partial<WorkRun> = {}): WorkRun {
  return {
    kind: 'run', id, type: 'job', workflowPath: 'workflows/job/workflow.md', title: id, repo: 'org/svc',
    status: 'complete', phase: 'evaluation', currentWorkItem: null, interactive: false, costUsd: 0,
    createdAt: '2026-06-01T09:00:00.000Z', updatedAt: '2026-06-01T09:00:00.000Z',
    group: 'recent', attention: null, ...extra,
  }
}

function review(id: string, extra: Partial<WorkReview> = {}): WorkReview {
  return {
    kind: 'review', id, title: id, prLabel: 'org/repo#1', prUrl: 'https://github.com/org/repo/pull/1', scm: 'github',
    prState: 'open', status: 'idle', openFindings: { blocker: 0, major: 0, minor: 0, nit: 0 }, rounds: 1,
    createdAt: '2026-06-01T09:00:00.000Z', updatedAt: '2026-06-01T09:00:00.000Z',
    group: 'waiting', attention: null, ...extra,
  }
}

function list(parts: Partial<Worklist>): Worklist {
  return { needsYou: 0, conversations: [], runs: [], reviews: [], ...parts }
}

describe('buildThreads', () => {
  it('nests a campaign child under its parent run, not under the conversation it inherited', () => {
    const threads = buildThreads(list({
      conversations: [conversation('c1')],
      runs: [
        run('parent', { investigationId: 'c1' }),
        run('child', { investigationId: 'c1', campaignParentId: 'parent' }),
      ],
    }))
    expect(threads).toHaveLength(1)
    const [plan] = threads
    expect(plan!.children.map(t => t.item.id)).toEqual(['parent'])
    expect(plan!.children[0]!.children.map(t => t.item.id)).toEqual(['child'])
  })

  it('lifts a thread to its most urgent member', () => {
    const threads = buildThreads(list({
      conversations: [conversation('c1')],
      runs: [run('stuck', { investigationId: 'c1', status: 'escalated', group: 'needs-you', attention: 'escalated' })],
    }))
    expect(groupThreads(threads)['needs-you'].map(t => t.item.id)).toEqual(['c1'])
    expect(countInGroup(groupThreads(threads)['needs-you'], 'needs-you')).toBe(1)
  })

  it('nests a review under the conversation that started it and leaves the rest top-level', () => {
    const threads = buildThreads(list({
      conversations: [conversation('c1', { reviewIds: ['r1'] })],
      reviews: [review('r1'), review('r2')],
      runs: [run('cli-run')],
    }))
    expect(threads.map(t => t.item.id).sort()).toEqual(['c1', 'cli-run', 'r2'])
    expect(threads.find(t => t.item.id === 'c1')!.children.map(t => t.item.id)).toEqual(['r1'])
  })

  it('survives a campaign loop', () => {
    const threads = buildThreads(list({ runs: [run('a', { campaignParentId: 'b' }), run('b', { campaignParentId: 'a' })] }))
    expect(threads.length).toBeLessThanOrEqual(2)
  })
})

describe('filterThreads', () => {
  const threads = buildThreads(list({
    conversations: [conversation('plan-x', { title: 'Rate limits' })],
    runs: [run('svc-run', { investigationId: 'plan-x', title: 'my-service' }), run('other', { title: 'billing' })],
  }))

  it('keeps a parent for context when only a child matches', () => {
    const result = filterThreads(threads, 'all', 'my-service')
    expect(result.map(t => t.item.id)).toEqual(['plan-x'])
    expect(result[0]!.children.map(t => t.item.id)).toEqual(['svc-run'])
  })

  it('filters by kind', () => {
    expect(filterThreads(threads, 'run', '').flatMap(t => [t.item.id, ...t.children.map(c => c.item.id)]).sort())
      .toEqual(['other', 'plan-x', 'svc-run'])
    expect(filterThreads(threads, 'review', '')).toEqual([])
  })
})

describe('navigation', () => {
  it('opens work beside the conversation that started it, and anything else on its own page', () => {
    const plan = conversation('c 1')
    expect(itemHref(plan, [])).toBe('/plans/c%201')
    expect(itemHref(run('j1'), [plan])).toBe('/plans/c%201?run=j1')
    expect(itemHref(run('j2'), [plan, run('j1')])).toBe('/plans/c%201?run=j2')
    expect(itemHref(review('r1'), [plan])).toBe('/plans/c%201?review=r1')
    expect(itemHref(run('j3'), [])).toBe('/jobs/j3')
    expect(itemHref(run('j4'), [run('j3')])).toBe('/jobs/j4')
    expect(itemHref(review('r2'), [])).toBe('/reviews/r2')
  })

  it('reads and writes the inspector without touching other parameters', () => {
    expect(parseInspector('?run=j1&review=r1')).toEqual({ kind: 'run', id: 'j1' })
    expect(parseInspector('?review=r1')).toEqual({ kind: 'review', id: 'r1' })
    expect(parseInspector('?x=1')).toBeNull()
    expect(withInspector('?x=1&run=j1', { kind: 'review', id: 'r1' })).toBe('?x=1&review=r1')
    expect(withInspector('?run=j1', null)).toBe('')
    expect(conversationHref('c1', { kind: 'run', id: 'j1' })).toBe('/plans/c1?run=j1')
  })

  it('knows which row is on screen', () => {
    expect(activeItemKey('/plans/c1', '?run=j1')).toBe('run:j1')
    expect(activeItemKey('/plans/c1', '')).toBe('conversation:c1')
    expect(activeItemKey('/jobs/j1', '')).toBe('run:j1')
    expect(activeItemKey('/reviews/r1', '')).toBe('review:r1')
    expect(activeItemKey('/jobs', '')).toBeNull()
    expect(activeItemKey('/settings', '')).toBeNull()
  })
})

describe('row detail', () => {
  it('explains why a run needs you', () => {
    expect(itemDetail(run('j', { attention: 'escalated', escalationMessage: 'Cannot reach PR\nmore' }))).toBe('Cannot reach PR')
    expect(itemDetail(run('j', { attention: 'input', awaitingEvent: 'developer-input: Which table?' }))).toBe('Which table?')
    expect(itemDetail(run('j', { attention: 'plan-approval' }))).toBe('Plan waiting for approval')
    expect(itemDetail(run('j', { currentWorkItem: 'add-endpoint' }))).toBe('add-endpoint')
  })
})

describe('runWaitingReason', () => {
  it('names a question, approval, escalation or failure, and not a developer pause', () => {
    expect(runWaitingReason({ status: 'awaiting-developer-input', awaitingEvent: 'developer-input: Which repo?' }))
      .toEqual({ title: 'Waiting for your answer', detail: 'Which repo?' })
    expect(runWaitingReason({ status: 'awaiting-developer-input', awaitingEvent: 'developer-input: paused by developer' }))
      .toBeNull()
    expect(runWaitingReason({ status: 'escalated', escalationMessage: 'Stuck' })).toEqual({ title: 'Escalated', detail: 'Stuck' })
    expect(runWaitingReason({ status: 'coding' })).toBeNull()
  })
})

describe('compactAge', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z')
  it.each([
    ['2026-06-01T11:59:50.000Z', 'now'],
    ['2026-06-01T11:55:00.000Z', '5m'],
    ['2026-06-01T09:00:00.000Z', '3h'],
    ['2026-05-29T12:00:00.000Z', '3d'],
    ['2026-04-20T12:00:00.000Z', '6w'],
  ])('%s → %s', (iso, expected) => {
    expect(compactAge(iso, now)).toBe(expected)
  })
})
