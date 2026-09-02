import {
  Boxes,
  Brain,
  FileText,
  FolderTree,
  Loader2,
  ScanSearch,
  Search,
  Ticket,
  type LucideIcon,
} from 'lucide-react'
import type { ActivityEntry, ActivityGroup, ActivityItem } from './types'

/**
 * Tool name → semantic group. Keep in sync with packages/runner/src/intake/tools.ts.
 *
 * BYO MCP tools arrive as `mcp__<serverId>__<toolName>`. The dashboard does not
 * depend on `@coro-ai/plugin-sdk`, so this regex mirrors `parseMcpToolName`
 * there rather than importing it.
 */
export function groupForTool(toolName: string): { group: ActivityGroup; externalId?: string } {
  switch (toolName) {
    case 'tracker_get_issue':
    case 'tracker_get_comments':
      return { group: 'tracker-read' }
    case 'tracker_search_issues':
      return { group: 'tracker-search' }
    case 'scm_read_file':
      return { group: 'repo-read' }
    case 'scm_list_files':
      return { group: 'repo-browse' }
    case 'scm_search_code':
      return { group: 'repo-search' }
    default: {
      const m = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(toolName)
      if (m) return { group: 'external', externalId: m[1] }
      return { group: 'working' }
    }
  }
}

/** Append an entry, merging into the trailing deck when it belongs to the same group. */
export function appendEntry(items: ActivityItem[], entry: ActivityEntry): ActivityItem[] {
  const last = items[items.length - 1]
  const sameDeck =
    last?.kind === 'activity' &&
    last.group === entry.group &&
    last.externalId === entry.externalId
  if (sameDeck) {
    const merged = { ...last, entries: [...last.entries, entry] }
    return [...items.slice(0, -1), merged]
  }
  return [
    ...items,
    {
      kind: 'activity',
      id: `act-${entry.id}`,
      group: entry.group,
      ...(entry.externalId ? { externalId: entry.externalId } : {}),
      entries: [entry],
    },
  ]
}

/** Settle a running entry in place, wherever it lives. */
export function settleEntry(
  items: ActivityItem[],
  entryId: string,
  patch: Partial<Pick<ActivityEntry, 'status' | 'settledLabel' | 'durationMs' | 'detail' | 'error'>>,
): ActivityItem[] {
  return items.map(item => {
    if (item.kind !== 'activity') return item
    const idx = item.entries.findIndex(entry => entry.id === entryId)
    if (idx < 0) return item
    const entries = item.entries.slice()
    entries[idx] = { ...entries[idx], ...patch }
    return { ...item, entries }
  })
}

export function appendMessage(
  items: ActivityItem[],
  role: 'user' | 'assistant',
  text: string,
  id: string,
): ActivityItem[] {
  return [...items, { kind: 'message', id, role, text }]
}

export const GROUP_META: Record<
  ActivityGroup,
  {
    icon: LucideIcon
    /** Roll-up shown on a collapsed deck holding 2+ entries. n is the entry count. */
    rollup: (n: number) => string
    /** Generic running label when the adapter has nothing specific. */
    fallbackRunning: string
  }
> = {
  'tracker-read': {
    icon: Ticket,
    rollup: n => `Read ${n} ticket${n === 1 ? '' : 's'}`,
    fallbackRunning: 'Reading a ticket',
  },
  'tracker-search': {
    icon: Search,
    rollup: n => `Ran ${n} ticket search${n === 1 ? '' : 'es'}`,
    fallbackRunning: 'Searching tickets',
  },
  'repo-read': {
    icon: FileText,
    rollup: n => `Read ${n} file${n === 1 ? '' : 's'}`,
    fallbackRunning: 'Reading a file',
  },
  'repo-browse': {
    icon: FolderTree,
    rollup: n => `Browsed ${n} director${n === 1 ? 'y' : 'ies'}`,
    fallbackRunning: 'Browsing the repo',
  },
  'repo-search': {
    icon: ScanSearch,
    rollup: n => `Ran ${n} code search${n === 1 ? '' : 'es'}`,
    fallbackRunning: 'Searching code',
  },
  thinking: {
    icon: Brain,
    rollup: n => `${n} thought${n === 1 ? '' : 's'}`,
    fallbackRunning: 'Thinking',
  },
  external: {
    icon: Boxes,
    rollup: n => `${n} lookup${n === 1 ? '' : 's'}`,
    fallbackRunning: 'Looking something up',
  },
  working: {
    icon: Loader2,
    rollup: n => `${n} step${n === 1 ? '' : 's'}`,
    fallbackRunning: 'Working',
  },
}
