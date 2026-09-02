import { Sparkles, Terminal, Ticket, Wrench } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import {
  appendEntry,
  groupForTool,
  iconForActivity,
  settleEntry,
  settleRunningEntries,
} from '../src/components/activity/group'
import type { ActivityEntry, ActivityItem } from '../src/components/activity/types'

function entry(over: Partial<ActivityEntry> & Pick<ActivityEntry, 'id' | 'group'>): ActivityEntry {
  return {
    sourceName: over.sourceName ?? over.group,
    status: over.status ?? 'running',
    runningLabel: over.runningLabel ?? 'Working',
    ...over,
  }
}

describe('groupForTool', () => {
  it('maps every intake tool, MCP names, and junk', () => {
    expect(groupForTool('tracker_get_issue')).toEqual({ group: 'tracker-read' })
    expect(groupForTool('tracker_get_comments')).toEqual({ group: 'tracker-read' })
    expect(groupForTool('tracker_search_issues')).toEqual({ group: 'tracker-search' })
    expect(groupForTool('scm_read_file')).toEqual({ group: 'repo-read' })
    expect(groupForTool('scm_list_files')).toEqual({ group: 'repo-browse' })
    expect(groupForTool('scm_search_code')).toEqual({ group: 'repo-search' })
    expect(groupForTool('mcp__catalog__lookup')).toEqual({ group: 'external', externalId: 'catalog' })
    expect(groupForTool('mcp__my_server__search')).toEqual({ group: 'external', externalId: 'my_server' })
    expect(groupForTool('mcp__coro__scm_list_files')).toEqual({ group: 'repo-browse' })
    expect(groupForTool('mcp__coro__scm_read_file')).toEqual({ group: 'repo-read' })
    expect(groupForTool('mcp__claude_ai_Atlassian__getJiraIssue')).toEqual({ group: 'tracker-read' })
    expect(groupForTool('totally_unknown')).toEqual({ group: 'working' })
  })
})

describe('iconForActivity', () => {
  it('picks a ticket glyph for Atlassian MCP tools even before grouping', () => {
    expect(iconForActivity('tracker-read', 'mcp__claude_ai_Atlassian__getJiraIssue')).toBe(Ticket)
    expect(iconForActivity('working', 'Bash')).toBe(Terminal)
    expect(iconForActivity('working', 'Skill')).toBe(Sparkles)
    expect(iconForActivity('working')).toBe(Wrench)
  })
})

describe('appendEntry', () => {
  it('merges two consecutive repo-read entries into one item', () => {
    const a = entry({ id: '1', group: 'repo-read', sourceName: 'scm_read_file' })
    const b = entry({ id: '2', group: 'repo-read', sourceName: 'scm_read_file' })
    const items = appendEntry(appendEntry([], a), b)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'activity', group: 'repo-read' })
    if (items[0].kind !== 'activity') throw new Error('expected activity')
    expect(items[0].entries.map(e => e.id)).toEqual(['1', '2'])
  })

  it('starts a new item when the group changes', () => {
    const a = entry({ id: '1', group: 'repo-read', sourceName: 'scm_read_file' })
    const b = entry({ id: '2', group: 'tracker-read', sourceName: 'tracker_get_issue' })
    const items = appendEntry(appendEntry([], a), b)
    expect(items).toHaveLength(2)
    expect(items.map(i => (i.kind === 'activity' ? i.group : i.kind))).toEqual(['repo-read', 'tracker-read'])
  })

  it('does not merge two external entries with different externalId', () => {
    const a = entry({ id: '1', group: 'external', externalId: 'catalog', sourceName: 'mcp__catalog__lookup' })
    const b = entry({ id: '2', group: 'external', externalId: 'other', sourceName: 'mcp__other__search' })
    const items = appendEntry(appendEntry([], a), b)
    expect(items).toHaveLength(2)
  })

  it('starts a new item when the previous item is a message even if an earlier item was the same group', () => {
    const a = entry({ id: '1', group: 'repo-read', sourceName: 'scm_read_file' })
    const afterRead = appendEntry([], a)
    const withMessage: ActivityItem[] = [
      ...afterRead,
      { kind: 'message', id: 'm1', role: 'assistant', text: 'Found it.' },
    ]
    const b = entry({ id: '2', group: 'repo-read', sourceName: 'scm_read_file' })
    const items = appendEntry(withMessage, b)
    expect(items).toHaveLength(3)
    expect(items[2]).toMatchObject({ kind: 'activity', group: 'repo-read' })
    if (items[2].kind !== 'activity') throw new Error('expected activity')
    expect(items[2].entries).toHaveLength(1)
  })
})

describe('settleEntry', () => {
  it('patches the right entry and leaves siblings untouched', () => {
    const a = entry({ id: '1', group: 'repo-read', sourceName: 'scm_read_file' })
    const b = entry({ id: '2', group: 'repo-read', sourceName: 'scm_read_file' })
    const items = appendEntry(appendEntry([], a), b)
    const settled = settleEntry(items, '1', { status: 'done', settledLabel: 'Read users.ts', durationMs: 12 })
    if (settled[0].kind !== 'activity') throw new Error('expected activity')
    expect(settled[0].entries[0]).toMatchObject({
      id: '1',
      status: 'done',
      settledLabel: 'Read users.ts',
      durationMs: 12,
    })
    expect(settled[0].entries[1]).toMatchObject({ id: '2', status: 'running' })
  })
})

describe('settleRunningEntries', () => {
  it('marks leftover running entries done and is a no-op when nothing is in flight', () => {
    const a = entry({ id: '1', group: 'working', sourceName: 'Skill', runningLabel: 'Skill' })
    const items = appendEntry([], a)
    const settled = settleRunningEntries(items)
    if (settled[0].kind !== 'activity') throw new Error('expected activity')
    expect(settled[0].entries[0]).toMatchObject({
      status: 'done',
      settledLabel: 'Skill',
    })
    expect(settleRunningEntries(settled)).toBe(settled)
  })
})
