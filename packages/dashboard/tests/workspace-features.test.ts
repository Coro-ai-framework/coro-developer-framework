import { describe, expect, it } from 'vitest'
import type { ActivityItem } from '../src/components/activity/types'
import { displayContent } from '../src/components/activity/message-block'
import { RUN_TOOL_NAMES, groupForTool } from '../src/components/activity/group'
import { normalizePrUrl, parseReviewRequest, withReviewCard } from '../src/lib/intake-review'
import { conversationHasLiveRun } from '../src/lib/linked-run'
import { reconcileSeen } from '../src/lib/unread'
import { toIntakeMessages } from '../src/lib/intake-stream'
import type { WorkConversation, Worklist, WorkRun } from '../src/lib/worklist'
import { diffAttention } from '../src/lib/attention'

describe('review proposals', () => {
  const reply = 'Worth a look.\n<review>\n{"prUrl": "https://github.com/org/repo/pull/12/files", "note": "Check the lock"}\n</review>'

  it('parses a review block and rejects anything that is not a pull request', () => {
    expect(parseReviewRequest(reply)).toEqual({ prUrl: 'https://github.com/org/repo/pull/12/files', note: 'Check the lock' })
    expect(parseReviewRequest('<review>{"prUrl": "https://github.com/org/repo"}</review>')).toBeNull()
    expect(parseReviewRequest('<review>not json</review>')).toBeNull()
    expect(parseReviewRequest('<review>{"prUrl": "org/repo#5"}</review>')).toEqual({ prUrl: 'org/repo#5', note: '' })
  })

  it('treats the same pull request as one card', () => {
    expect(normalizePrUrl('https://GitHub.com/org/repo/pull/12/files/')).toBe(normalizePrUrl('https://github.com/org/repo/pull/12'))
    const once = withReviewCard([], reply, 'card-1')
    expect(once).toHaveLength(1)
    expect(withReviewCard(once, reply, 'card-2')).toBe(once)
  })

  it('hides the block from the chat and leaves a pointer when nothing else was said', () => {
    expect(displayContent('assistant', reply)).toBe('Worth a look.')
    expect(displayContent('assistant', '<review>{"prUrl":"org/repo#1"}</review>')).toContain('review below')
    expect(displayContent('assistant', 'Looking now <revi')).toBe('Looking now')
  })

  it('round-trips the card into the transcript plan mode reads', () => {
    const items = withReviewCard([], reply, 'card-1')
    expect(toIntakeMessages(items)[0]?.content).toContain('<review>')
  })
})

describe('conversationHasLiveRun', () => {
  const items: ActivityItem[] = [{
    kind: 'card',
    id: 'c',
    card: { type: 'run', data: { state: 'dispatched', jobId: 'j1', run: {} } },
  }]

  it('is true only while a dispatched run is still going', () => {
    expect(conversationHasLiveRun(items, [{ id: 'j1', status: 'coding' }])).toBe(true)
    expect(conversationHasLiveRun(items, [{ id: 'j1', status: 'complete' }])).toBe(false)
    expect(conversationHasLiveRun(items, [])).toBe(false)
  })
})

describe('run tool activity', () => {
  it('stacks every run tool into one deck, prefixed or not', () => {
    for (const name of RUN_TOOL_NAMES) {
      expect(groupForTool(name).group).toBe('run-control')
      expect(groupForTool(`mcp__coro__${name}`).group).toBe('run-control')
    }
  })
})

describe('unread', () => {
  const base: WorkRun = {
    kind: 'run', id: 'j1', type: 'job', workflowPath: 'w', title: 't', repo: null, status: 'coding', phase: 'coding',
    currentWorkItem: null, interactive: false, costUsd: 0, createdAt: '', updatedAt: '2026-01-01T00:00:00.000Z',
    group: 'working', attention: null,
  }

  it('starts read, lights up on a meaningful change, and clears when seen', () => {
    const first = reconcileSeen({}, [base], new Set())
    expect(first.unread.size).toBe(0)

    const touched = reconcileSeen(first.seen, [{ ...base, updatedAt: '2026-01-01T00:01:00.000Z' }], new Set())
    expect(touched.unread.size).toBe(0)

    const parked = { ...base, status: 'awaiting-developer-input' }
    const changed = reconcileSeen(first.seen, [parked], new Set())
    expect([...changed.unread]).toEqual(['run:j1'])

    const seen = reconcileSeen(changed.seen, [parked], new Set(['run:j1']))
    expect(seen.unread.size).toBe(0)
  })

  it('forgets rows that left the list', () => {
    const first = reconcileSeen({}, [base], new Set())
    const gone = reconcileSeen(first.seen, [], new Set())
    expect(gone.seen).toEqual({})
    expect(gone.changed).toBe(true)
  })
})

describe('attention', () => {
  const quiet: Worklist = { needsYou: 0, conversations: [], runs: [], reviews: [] }
  const plan: WorkConversation = {
    kind: 'conversation', id: 'c1', title: 'Rate limits', status: 'dispatched', readinessState: 'ready', openQuestions: 0,
    streaming: false, pendingPermissions: 0, reviewIds: [], createdAt: '', updatedAt: '', group: 'recent', attention: null,
  }
  const working: WorkRun = {
    kind: 'run', id: 'j1', type: 'job', workflowPath: 'w', title: 'svc', repo: null, status: 'coding', phase: 'coding',
    currentWorkItem: null, interactive: true, costUsd: 0, createdAt: '', updatedAt: '', group: 'working', attention: null,
    investigationId: 'c1',
  }

  it('fires when something arrives in needs-you, never on first load', () => {
    const before: Worklist = { ...quiet, conversations: [plan], runs: [working] }
    const parked: WorkRun = { ...working, status: 'awaiting-developer-input', awaitingEvent: 'developer-input: Which table?', group: 'needs-you', attention: 'input' }
    const after: Worklist = { ...before, needsYou: 1, runs: [parked] }
    expect(diffAttention(null, after)).toEqual([])
    expect(diffAttention(before, after)).toEqual([
      { key: 'run:j1', title: 'A run needs you: svc', body: 'Which table?', path: '/plans/c1?run=j1' },
    ])
    expect(diffAttention(after, after)).toEqual([])
  })

  it('fires when a plan-mode turn finishes', () => {
    const streaming: Worklist = { ...quiet, conversations: [{ ...plan, status: 'active', streaming: true, group: 'working' }] }
    const done: Worklist = { ...quiet, conversations: [{ ...plan, status: 'active', streaming: false, openQuestions: 2, readinessState: 'investigating', group: 'waiting' }] }
    expect(diffAttention(streaming, done)).toEqual([
      { key: 'conversation:c1', title: 'Plan mode replied: Rate limits', body: '2 questions for you.', path: '/plans/c1' },
    ])
  })
})
