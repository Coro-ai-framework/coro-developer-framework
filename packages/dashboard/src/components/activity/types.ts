// ─────────────────────────────────────────────────────────────────────────────
// Source-agnostic activity model.
//
// RULE: nothing in components/activity/** may import from components/plan/**,
// hooks/useIntakeStream.ts, or lib/intake-brief.ts. This layer knows about
// messages, activity entries, notices and OPAQUE cards — never about briefs,
// jobs, or a specific SSE wire format. Each event source gets an adapter in
// ./adapters that maps its own events onto ActivityItem[].
// ─────────────────────────────────────────────────────────────────────────────

import type { ActivityCard } from './cards/types'

export type { ActivityCard }

/** Semantic bucket that decides which entries stack together into one deck. */
export type ActivityGroup =
  | 'tracker-read'
  | 'tracker-search'
  | 'repo-read'
  | 'repo-browse'
  | 'repo-search'
  | 'thinking'
  | 'external' // BYO MCP servers — carries `externalId`
  | 'working' // unknown / fallback

/** One thing the agent did. Maps 1:1 to a tool_start…tool_end pair for intake. */
export interface ActivityEntry {
  id: string
  group: ActivityGroup
  /** Raw source name, e.g. 'scm_read_file' or 'mcp__catalog__lookup'. For detail view only. */
  sourceName: string
  /** Server-side plugin/server id when group === 'external'. */
  externalId?: string
  status: 'running' | 'done' | 'failed'
  /** Label while running, e.g. 'Reading src/api/users.ts'. Adapter supplies it. */
  runningLabel: string
  /** Label once settled, e.g. 'Read src/api/users.ts'. Adapter supplies it. */
  settledLabel?: string
  durationMs?: number
  /** Anything worth showing in the expanded detail pane. Rendered as JSON. */
  detail?: unknown
  error?: string
}

export type ActivityItem =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string }
  | { kind: 'activity'; id: string; group: ActivityGroup; externalId?: string; entries: ActivityEntry[] }
  | { kind: 'card'; id: string; card: ActivityCard }
  | { kind: 'notice'; id: string; tone: 'info' | 'warning' | 'error'; text: string; action?: NoticeAction }

export interface NoticeAction {
  label: string
  /** Router path or absolute URL. The feed renders a link, never a callback, so
   *  notices stay serialisable into localStorage. */
  to: string
}
