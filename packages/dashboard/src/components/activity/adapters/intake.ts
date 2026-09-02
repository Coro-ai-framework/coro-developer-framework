import { appendEntry, groupForTool, namesMatchTool, settleEntry, settleRunningEntries, toolLeafName } from '../group'
import type { ActivityEntry, ActivityItem } from '../types'

/** Mirrors the payloads written by POST /intake/stream (server.ts 1392-1415). */
export type IntakeEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_start'; name: string; input?: unknown }
  | { type: 'tool_end'; name: string; durationMs?: number; ok?: boolean; summary?: string; error?: string }
  | { type: 'done'; usage?: { inputTokens: number; outputTokens: number; totalTokens: number } }
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
function findLastRunning(items: ActivityItem[], sourceName: string): ActivityEntry | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind !== 'activity') continue
    for (let j = item.entries.length - 1; j >= 0; j--) {
      const entry = item.entries[j]
      if (entry.status === 'running' && namesMatchTool(entry.sourceName, sourceName)) return entry
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
): ActivityEntry | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind !== 'activity') continue
    for (let j = item.entries.length - 1; j >= 0; j--) {
      const entry = item.entries[j]
      if (entry.status !== 'running' || !namesMatchTool(entry.sourceName, sourceName)) continue
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
      const duplicate = findDuplicateStart(items, event.name, event.input)
      if (duplicate) {
        const label = runningLabelFor(event.name, event.input)
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
        status: 'running',
        runningLabel: runningLabelFor(event.name, event.input),
        detail: event.input,
      }
      return appendEntry(items, entry)
    }
    case 'tool_end': {
      const running = findLastRunning(items, event.name)
      if (!running) return items
      return settleEntry(items, running.id, {
        status: event.ok === false ? 'failed' : 'done',
        settledLabel: event.summary ?? running.runningLabel,
        durationMs: event.durationMs,
        ...(event.error ? { error: event.error } : {}),
      })
    }
    // Streaming text and turn lifecycle live on the session provider, not
    // in this reducer — appending per-token would rewrite the item array
    // 24 characters at a time.
    case 'token':
      return items
    case 'done':
    case 'error':
      return settleRunningEntries(items)
  }
}
