import {
  Boxes,
  Brain,
  FileText,
  FolderTree,
  Globe,
  ScanSearch,
  Search,
  Sparkles,
  Terminal,
  Ticket,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { ActivityEntry, ActivityGroup, ActivityItem } from './types'

const MCP_NAME = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/

export function toolLeafName(toolName: string): string {
  const m = MCP_NAME.exec(toolName)
  return m?.[2] ?? toolName
}

function mcpServerId(toolName: string): string | undefined {
  return MCP_NAME.exec(toolName)?.[1]
}

/**
 * Tool name → semantic group. Keep in sync with packages/runner/src/intake/tools.ts.
 *
 * BYO MCP tools arrive as `mcp__<serverId>__<toolName>`. The dashboard does not
 * depend on `@coro-ai/plugin-sdk`, so this regex mirrors `parseMcpToolName`
 * there rather than importing it.
 *
 * First-party intake tools are also invoked as `mcp__coro__scm_list_files`
 * (Claude Agent SDK). Group by the leaf name so those stack with `scm_list_files`
 * instead of opening a new chip. `externalId` is only for unknown third-party
 * MCP servers — known kinds (ticket read, file read) share a deck.
 */
export function groupForTool(toolName: string): { group: ActivityGroup; externalId?: string } {
  const leaf = toolLeafName(toolName)
  switch (leaf) {
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
      const lowered = leaf.toLowerCase()
      const haystack = `${toolName} ${leaf}`.toLowerCase()
      if (/jira|ticket|issue|atlassian|linear|shortcut/.test(haystack)) {
        return /search/.test(lowered) ? { group: 'tracker-search' } : { group: 'tracker-read' }
      }
      if (/search/.test(lowered) && /code|grep|symbol/.test(lowered)) {
        return { group: 'repo-search' }
      }
      if (/list.?file|glob|browse/.test(lowered)) {
        return { group: 'repo-browse' }
      }
      if (/\bread\b|get.?file|^cat$/.test(lowered)) {
        return { group: 'repo-read' }
      }
      const serverId = mcpServerId(toolName)
      if (serverId && serverId !== 'coro') return { group: 'external', externalId: serverId }
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

/** Patch an entry in place, wherever it lives. */
export function settleEntry(
  items: ActivityItem[],
  entryId: string,
  patch: Partial<Pick<ActivityEntry, 'status' | 'runningLabel' | 'settledLabel' | 'durationMs' | 'detail' | 'error'>>,
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

/** Mark every still-running entry done. Used when a turn ends without tool_end frames. */
export function settleRunningEntries(items: ActivityItem[]): ActivityItem[] {
  let changed = false
  const next = items.map(item => {
    if (item.kind !== 'activity') return item
    if (!item.entries.some(entry => entry.status === 'running')) return item
    changed = true
    return {
      ...item,
      entries: item.entries.map(entry =>
        entry.status === 'running'
          ? { ...entry, status: 'done' as const, settledLabel: entry.settledLabel ?? entry.runningLabel }
          : entry,
      ),
    }
  })
  return changed ? next : items
}

export function namesMatchTool(sourceName: string, eventName: string): boolean {
  if (sourceName === eventName) return true
  const a = toolLeafName(sourceName)
  const b = toolLeafName(eventName)
  return a.length > 0 && a === b
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
    icon: Wrench,
    rollup: n => `${n} step${n === 1 ? '' : 's'}`,
    fallbackRunning: 'Working',
  },
}

/** Glyph for a deck or row. Group supplies the default; the leaf name can pick a tighter match. */
export function iconForActivity(group: ActivityGroup, sourceName?: string): LucideIcon {
  const leaf = sourceName ? toolLeafName(sourceName).toLowerCase() : ''
  const hay = `${sourceName ?? ''} ${leaf}`.toLowerCase()
  if (/jira|ticket|issue|atlassian|linear|shortcut/.test(hay)) return Ticket
  if (/bash|shell|terminal|^cmd$/.test(leaf)) return Terminal
  if (/^skill$|skill_/.test(leaf)) return Sparkles
  if (/web.?search|webfetch|web_fetch|http|browser/.test(leaf)) return Globe
  if (/glob|list.?file|browse/.test(leaf)) return FolderTree
  if (/grep|code.?search|symbol/.test(leaf)) return ScanSearch
  if (/\bread\b|write|edit|get.?file/.test(leaf)) return FileText
  if (/search/.test(leaf) && /ticket|jira|issue/.test(hay)) return Search
  return GROUP_META[group].icon
}
