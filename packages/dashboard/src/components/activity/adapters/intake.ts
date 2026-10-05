import { appendEntry, groupForTool, namesMatchTool, settleEntry, settleRunningEntries, toolLeafName } from '../group'
import type { ActivityEntry, ActivityItem } from '../types'
import type { IntakePermissionRequest } from '../../../lib/intake-investigation'

export type { IntakePermissionRequest }

export interface PermissionCardData {
  request: IntakePermissionRequest
  status: 'pending' | 'allowed' | 'denied' | 'expired'
  by?: string
}

/** Mirrors the payloads written by POST /intake/stream. */
export type IntakeEvent =
  | { type: 'token'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; name: string; input?: unknown; subagent?: string }
  | { type: 'tool_end'; name: string; durationMs?: number; ok?: boolean; summary?: string; error?: string; subagent?: string }
  | { type: 'permission_request'; request: IntakePermissionRequest }
  | { type: 'permission_resolved'; requestId: string; decision: 'allow' | 'deny'; by: 'developer' | 'timeout' | 'abort' }
  | {
      type: 'done'
      usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
      contextTokens?: number
      sessionTokens?: number
      turns?: number
    }
  | { type: 'error'; message: string; reason?: string }

let entrySeq = 0

export function resetIntakeEntryCounterForTests(): void {
  entrySeq = 0
}

function nextEntryId(): string {
  entrySeq += 1
  return `intake-entry-${entrySeq}`
}

function clip(value: string, max = 48): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function readField(input: unknown, field: string): string | null {
  if (input && typeof input === 'object' && field in (input as Record<string, unknown>)) {
    const v = (input as Record<string, unknown>)[field]
    return v == null ? null : String(v)
  }
  return null
}

export function runningLabelFor(name: string, input: unknown): string {
  const leaf = toolLeafName(name)
  switch (leaf) {
    case 'tracker_get_issue': {
      const key = issueKeyFrom(input)
      return key ? `Reading ${clip(key)}` : 'Reading a ticket'
    }
    case 'tracker_get_comments': {
      const key = issueKeyFrom(input)
      return key ? `Reading comments on ${clip(key)}` : 'Reading comments'
    }
    case 'tracker_search_issues': {
      const query = readField(input, 'query')
      return query ? `Searching tickets for "${clip(query)}"` : 'Searching tickets'
    }
    case 'scm_read_file': {
      const path = readField(input, 'path')
      return path ? `Reading ${clip(path)}` : 'Reading a file'
    }
    case 'scm_list_files': {
      const path = readField(input, 'path')
      return path ? `Browsing ${clip(path)}` : 'Browsing the repo root'
    }
    case 'scm_search_code': {
      const query = readField(input, 'query')
      return query ? `Searching code for "${clip(query)}"` : 'Searching code'
    }
    case 'Bash':
    case 'shell': {
      const command = readField(input, 'command')
      return command ? `Running ${clip(command)}` : 'Running a command'
    }
    case 'WebFetch':
    case 'web_fetch': {
      const url = readField(input, 'url')
      if (!url) return 'Fetching a page'
      try { return `Fetching ${clip(new URL(url).hostname)}` }
      catch { return `Fetching ${clip(url)}` }
    }
    case 'WebSearch': {
      const query = readField(input, 'query')
      return query ? `Searching the web for "${clip(query)}"` : 'Searching the web'
    }
    case 'Read':
    case 'file_read': {
      const path = readField(input, 'path') ?? readField(input, 'file_path')
      return path ? `Reading ${clip(path)}` : 'Reading a file'
    }
    case 'Write':
    case 'Edit':
    case 'file_write':
    case 'file_edit': {
      const path = readField(input, 'path') ?? readField(input, 'file_path')
      return path ? `Writing ${clip(path)}` : 'Writing a file'
    }
    case 'request_tool_access': {
      const capability = readField(input, 'capability')
      return capability ? `Asking to enable ${clip(capability)}` : 'Asking to enable a tool'
    }
    case 'delegate_investigation': {
      const tasks = input && typeof input === 'object' ? (input as { tasks?: unknown }).tasks : undefined
      const n = Array.isArray(tasks) ? tasks.length : 0
      return n > 0 ? `Delegating ${n} investigation${n === 1 ? '' : 's'}` : 'Delegating investigations'
    }
    default: {
      const key = issueKeyFrom(input)
      if (/jira|ticket|issue|atlassian|linear/i.test(name) || /jira|issue|ticket/i.test(leaf)) {
        return key ? `Reading ${clip(key)}` : 'Reading a ticket'
      }
      return humanizeToolName(leaf || name)
    }
  }
}

function looksLikeIssueKey(value: string): boolean {
  return /^[A-Z][A-Z0-9]+-\d+$/i.test(value.trim())
}

function issueKeyFrom(input: unknown): string | null {
  const preferred =
    readField(input, 'key') ?? readField(input, 'issueKey') ?? readField(input, 'issue_key')
  if (preferred) return preferred
  const issueId = readField(input, 'issueId') ?? readField(input, 'id')
  if (issueId && looksLikeIssueKey(issueId)) return issueId
  return null
}

function humanizeToolName(raw: string): string {
  const spaced = raw
    .replace(/[/_.-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
  if (!spaced) return 'Working'
  const titled = spaced.charAt(0).toUpperCase() + spaced.slice(1)
  if (/^get /i.test(titled)) return `Reading ${titled.slice(4)}`
  return titled
}

/**
 * Match the most recent in-flight entry with the same source name. The
 * executor fires tool_end in the same order it queued tool_start, so the
 * last running one is the one resolving now.
 */
function withActor(label: string, actor?: string): string {
  return actor ? `${actor} · ${label}` : label
}

function findLastRunning(items: ActivityItem[], sourceName: string, actor?: string): ActivityEntry | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind !== 'activity') continue
    for (let j = item.entries.length - 1; j >= 0; j--) {
      const entry = item.entries[j]
      if (entry.status === 'running' && namesMatchTool(entry.sourceName, sourceName) && entry.actor === actor) {
        return entry
      }
    }
  }
  return undefined
}

function inputsMatch(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  } catch {
    return a === b
  }
}

function findDuplicateStart(
  items: ActivityItem[],
  sourceName: string,
  input: unknown,
  actor?: string,
): ActivityEntry | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind !== 'activity') continue
    for (let j = item.entries.length - 1; j >= 0; j--) {
      const entry = item.entries[j]
      if (entry.status !== 'running' || !namesMatchTool(entry.sourceName, sourceName) || entry.actor !== actor) continue
      // mcp__coro__scm_list_files and scm_list_files are the same call observed
      // twice. Parallel calls of the same tool use different inputs.
      if (entry.sourceName !== sourceName || inputsMatch(entry.detail, input)) return entry
    }
  }
  return undefined
}

export function applyIntakeEvent(items: ActivityItem[], event: IntakeEvent): ActivityItem[] {
  switch (event.type) {
    case 'tool_start': {
      const duplicate = findDuplicateStart(items, event.name, event.input, event.subagent)
      if (duplicate) {
        const label = withActor(runningLabelFor(event.name, event.input), event.subagent)
        const richer = label.length > duplicate.runningLabel.length
        if (!richer && duplicate.detail !== undefined) return items
        return settleEntry(items, duplicate.id, {
          runningLabel: richer ? label : duplicate.runningLabel,
          detail: event.input ?? duplicate.detail,
        })
      }
      const { group, externalId } = groupForTool(event.name)
      const entry: ActivityEntry = {
        id: nextEntryId(),
        group,
        sourceName: toolLeafName(event.name),
        ...(externalId ? { externalId } : {}),
        ...(event.subagent ? { actor: event.subagent } : {}),
        status: 'running',
        runningLabel: withActor(runningLabelFor(event.name, event.input), event.subagent),
        detail: event.input,
      }
      return appendEntry(items, entry)
    }
    case 'tool_end': {
      const running = findLastRunning(items, event.name, event.subagent)
      if (!running) return items
      return settleEntry(items, running.id, {
        status: event.ok === false ? 'failed' : 'done',
        settledLabel: event.summary
          ? withActor(event.summary, event.subagent)
          : running.runningLabel,
        durationMs: event.durationMs,
        ...(event.error ? { error: event.error } : {}),
      })
    }
    // Streaming text and thinking live on the session provider, not
    // in this reducer — appending per-token would rewrite the item array
    // 24 characters at a time. Thoughts are committed into items when
    // a tool starts or the turn ends, so they sit in chronological order.
    case 'token':
    case 'thinking':
      return items
    case 'permission_request': {
      const id = `perm-${event.request.requestId}`
      if (items.some(item => item.id === id)) return items
      return [
        ...items,
        {
          kind: 'card',
          id,
          card: { type: 'permission', data: { request: event.request, status: 'pending' } satisfies PermissionCardData },
        },
      ]
    }
    case 'permission_resolved':
      return items.map(item => {
        if (item.kind !== 'card' || item.card.type !== 'permission' || item.id !== `perm-${event.requestId}`) return item
        const data = item.card.data as PermissionCardData
        return {
          ...item,
          card: {
            ...item.card,
            data: {
              ...data,
              status: event.decision === 'allow' ? 'allowed' : 'denied',
              by: event.by,
            } satisfies PermissionCardData,
          },
        }
      })
    case 'done':
    case 'error':
      return expirePendingPermissions(settleRunningEntries(items))
  }
}

function expirePendingPermissions(items: ActivityItem[]): ActivityItem[] {
  let changed = false
  const next = items.map(item => {
    if (item.kind !== 'card' || item.card.type !== 'permission') return item
    const data = item.card.data as PermissionCardData
    if (data.status !== 'pending') return item
    changed = true
    return { ...item, card: { ...item.card, data: { ...data, status: 'expired' } satisfies PermissionCardData } }
  })
  return changed ? next : items
}

/** Re-attach permission cards after a refresh, without duplicating ones already shown. */
export function ensurePermissionCards(items: ActivityItem[], pending: IntakePermissionRequest[]): ActivityItem[] {
  let next = items
  for (const request of pending) {
    next = applyIntakeEvent(next, { type: 'permission_request', request })
  }
  return next
}
