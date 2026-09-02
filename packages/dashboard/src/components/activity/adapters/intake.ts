import { appendEntry, groupForTool, settleEntry } from '../group'
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
  switch (name) {
    case 'tracker_get_issue': {
      const key = readField(input, 'key')
      return key ? `Reading ${clip(key)}` : 'Reading a ticket'
    }
    case 'tracker_get_comments': {
      const key = readField(input, 'key')
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
      const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name)
      if (m) return `${m[1]}: ${m[2]}`
      return 'Working'
    }
  }
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
      if (entry.sourceName === sourceName && entry.status === 'running') return entry
    }
  }
  return undefined
}

export function applyIntakeEvent(items: ActivityItem[], event: IntakeEvent): ActivityItem[] {
  switch (event.type) {
    case 'tool_start': {
      const { group, externalId } = groupForTool(event.name)
      const entry: ActivityEntry = {
        id: nextEntryId(),
        group,
        sourceName: event.name,
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
    case 'done':
    case 'error':
      return items
  }
}
