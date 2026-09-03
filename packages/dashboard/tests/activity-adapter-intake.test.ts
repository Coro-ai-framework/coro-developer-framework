import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyIntakeEvent,
  resetIntakeEntryCounterForTests,
  runningLabelFor,
  type IntakeEvent,
} from '../src/components/activity/adapters/intake'
import type { ActivityItem } from '../src/components/activity/types'

beforeEach(() => {
  resetIntakeEntryCounterForTests()
})

function start(name: string, input?: unknown): IntakeEvent {
  return { type: 'tool_start', name, input }
}

function end(name: string, over: Partial<Extract<IntakeEvent, { type: 'tool_end' }>> = {}): IntakeEvent {
  return { type: 'tool_end', name, ok: true, summary: `Done ${name}`, ...over }
}

describe('applyIntakeEvent', () => {
  it('stacks two consecutive scm_read_file pairs into one activity item with two done entries', () => {
    let items: ActivityItem[] = []
    items = applyIntakeEvent(items, start('scm_read_file', { path: 'a.ts' }))
    items = applyIntakeEvent(items, end('scm_read_file', { summary: 'Read a.ts' }))
    items = applyIntakeEvent(items, start('scm_read_file', { path: 'b.ts' }))
    items = applyIntakeEvent(items, end('scm_read_file', { summary: 'Read b.ts' }))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'activity', group: 'repo-read' })
    if (items[0].kind !== 'activity') throw new Error('expected activity')
    expect(items[0].entries).toHaveLength(2)
    expect(items[0].entries.every(e => e.status === 'done')).toBe(true)
    expect(items[0].entries.map(e => e.settledLabel)).toEqual(['Read a.ts', 'Read b.ts'])
  })

  it('starts a new item when scm_read_file is followed by tracker_get_issue', () => {
    let items: ActivityItem[] = []
    items = applyIntakeEvent(items, start('scm_read_file', { path: 'a.ts' }))
    items = applyIntakeEvent(items, end('scm_read_file'))
    items = applyIntakeEvent(items, start('tracker_get_issue', { key: 'PROJ-1' }))
    items = applyIntakeEvent(items, end('tracker_get_issue', { summary: 'Read PROJ-1' }))
    expect(items).toHaveLength(2)
    expect(items.map(i => (i.kind === 'activity' ? i.group : i.kind))).toEqual(['repo-read', 'tracker-read'])
  })

  it('marks the matching entry failed and stores error when ok is false', () => {
    let items: ActivityItem[] = []
    items = applyIntakeEvent(items, start('scm_read_file', { path: 'missing.ts' }))
    items = applyIntakeEvent(items, end('scm_read_file', { ok: false, error: '404', summary: 'Read missing.ts' }))
    if (items[0].kind !== 'activity') throw new Error('expected activity')
    expect(items[0].entries[0]).toMatchObject({ status: 'failed', error: '404' })
  })

  it('settles interleaved starts by name', () => {
    let items: ActivityItem[] = []
    items = applyIntakeEvent(items, start('scm_read_file', { path: 'a.ts' }))
    items = applyIntakeEvent(items, start('tracker_get_issue', { key: 'PROJ-1' }))
    items = applyIntakeEvent(items, end('scm_read_file', { summary: 'Read a.ts' }))
    items = applyIntakeEvent(items, end('tracker_get_issue', { summary: 'Read PROJ-1' }))
    expect(items).toHaveLength(2)
    if (items[0].kind !== 'activity' || items[1].kind !== 'activity') throw new Error('expected activity')
    expect(items[0].entries[0]).toMatchObject({ sourceName: 'scm_read_file', status: 'done', settledLabel: 'Read a.ts' })
    expect(items[1].entries[0]).toMatchObject({
      sourceName: 'tracker_get_issue',
      status: 'done',
      settledLabel: 'Read PROJ-1',
    })
  })

  it('leaves items referentially unchanged for token, thinking, and empty done/error', () => {
    const items: ActivityItem[] = []
    expect(applyIntakeEvent(items, { type: 'token', text: 'hi' })).toBe(items)
    expect(applyIntakeEvent(items, { type: 'thinking', text: 'hmm' })).toBe(items)
    expect(applyIntakeEvent(items, { type: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })).toBe(
      items,
    )
    expect(applyIntakeEvent(items, { type: 'error', message: 'nope' })).toBe(items)
  })

  it('settles leftover running entries when the turn ends without tool_end', () => {
    let items: ActivityItem[] = []
    items = applyIntakeEvent(items, start('mcp__claude_ai_Atlassian__getJiraIssue', { issueId: 'WS-5144' }))
    expect(items[0]).toMatchObject({ kind: 'activity', group: 'tracker-read' })
    if (items[0].kind !== 'activity') throw new Error('expected activity')
    expect(items[0].entries[0]).toMatchObject({ status: 'running', runningLabel: 'Reading WS-5144' })
    items = applyIntakeEvent(items, { type: 'done' })
    if (items[0].kind !== 'activity') throw new Error('expected activity')
    expect(items[0].entries[0]).toMatchObject({
      status: 'done',
      settledLabel: 'Reading WS-5144',
    })
  })

  it('matches tool_end by MCP leaf name when the start used the full mcp__ name', () => {
    let items: ActivityItem[] = []
    items = applyIntakeEvent(items, start('mcp__claude_ai_Atlassian__getJiraIssue'))
    items = applyIntakeEvent(items, end('getJiraIssue', { summary: 'Read WS-5144' }))
    if (items[0].kind !== 'activity') throw new Error('expected activity')
    expect(items[0].entries[0]).toMatchObject({ status: 'done', settledLabel: 'Read WS-5144' })
  })

  it('stacks duplicate mcp__coro__ and canonical starts into one deck, and a different group starts a new line', () => {
    let items: ActivityItem[] = []
    items = applyIntakeEvent(items, start('mcp__coro__scm_list_files', { path: 'internal/platform' }))
    items = applyIntakeEvent(items, start('scm_list_files', { path: 'internal/platform' }))
    items = applyIntakeEvent(items, end('scm_list_files', { summary: 'Listed 14 entries in internal/platform' }))
    items = applyIntakeEvent(items, start('mcp__coro__scm_list_files', { path: 'internal/platform/db' }))
    items = applyIntakeEvent(items, start('scm_list_files', { path: 'internal/platform/db' }))
    items = applyIntakeEvent(items, end('scm_list_files', { summary: 'Listed 2 entries in internal/platform/db' }))
    items = applyIntakeEvent(items, start('mcp__coro__scm_read_file', { path: 'internal/platform/db/db.go' }))
    items = applyIntakeEvent(items, start('scm_read_file', { path: 'internal/platform/db/db.go' }))
    items = applyIntakeEvent(items, end('scm_read_file', { summary: 'Read internal/platform/db/db.go' }))
    items = applyIntakeEvent(items, start('scm_read_file', { path: 'internal/platform/outbox/dispatcher.go' }))
    items = applyIntakeEvent(items, end('scm_read_file', { summary: 'Read internal/platform/outbox/dispatcher.go' }))

    expect(items.map(i => (i.kind === 'activity' ? i.group : i.kind))).toEqual(['repo-browse', 'repo-read'])
    if (items[0].kind !== 'activity' || items[1].kind !== 'activity') throw new Error('expected activity')
    expect(items[0].entries).toHaveLength(2)
    expect(items[0].entries.map(e => e.settledLabel)).toEqual([
      'Listed 14 entries in internal/platform',
      'Listed 2 entries in internal/platform/db',
    ])
    expect(items[1].entries).toHaveLength(2)
    expect(items[1].entries.every(e => e.status === 'done')).toBe(true)
  })
})

describe('runningLabelFor', () => {
  it('humanizes MCP Atlassian tools instead of dumping the server id', () => {
    expect(runningLabelFor('mcp__claude_ai_Atlassian__getJiraIssue', { issueId: 'WS-5144' })).toBe('Reading WS-5144')
    expect(runningLabelFor('mcp__claude_ai_Atlassian__getJiraIssue', { cloudId: 'abc' })).toBe('Reading a ticket')
    expect(runningLabelFor('mcp__coro__scm_list_files', { path: 'internal/platform' })).toBe(
      'Browsing internal/platform',
    )
    expect(runningLabelFor('Bash', { command: 'ls' })).toBe('Bash')
  })
})
