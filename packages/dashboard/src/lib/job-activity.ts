import type { LogLine, LogLineType } from '../hooks/useJobStream'
import type { Job } from '../types'
import { PAUSED_AWAITING_EVENT } from './status'

/**
 * Line types that represent what the agent last did or said. Everything else
 * on the stream is bookkeeping (`[usage]`, `[init]`, `[artifact]`, tool
 * summaries) and would make a one-line activity row read as noise.
 */
const MEANINGFUL_LINE_TYPES: LogLineType[] = [
  'text',
  'result',
  'tool_use',
  'phase',
  'human',
  'insight',
  'error',
  'warning',
  'guardrail',
]

export interface ActivitySnippet {
  text: string
  lineType: LogLineType
}

/** Strip the log's own markers so the row reads as prose. */
export function stripActivityPrefix(content: string): string {
  return content
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/^→\s*/, '')
    .replace(/^⏳\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The most recent meaningful line, or null when the stream has none yet. */
export function lastAgentActivity(lines: LogLine[]): ActivitySnippet | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !MEANINGFUL_LINE_TYPES.includes(line.lineType)) continue
    const text = stripActivityPrefix(line.content)
    if (!text) continue
    return { text, lineType: line.lineType }
  }
  return null
}

type ActivityFallbackSource = Pick<Job, 'status' | 'phase'> &
  Partial<Pick<Job, 'awaitingEvent' | 'escalationMessage' | 'currentWorkItem'>>

/**
 * What to show when the stream has no line to offer: a terminal run (the
 * card deliberately opens no stream for one) or a run parked long enough
 * that the tail predates the park.
 */
export function activityFallback(job: ActivityFallbackSource): ActivitySnippet {
  if (job.status === 'escalated' && job.escalationMessage) {
    return { text: job.escalationMessage, lineType: 'error' }
  }
  if (job.status === 'complete') return { text: 'All phases complete.', lineType: 'result' }
  if (job.status === 'cancelled') return { text: 'Run cancelled.', lineType: 'system' }
  if (job.status === 'failed') return { text: 'Run failed.', lineType: 'error' }
  if (job.awaitingEvent === PAUSED_AWAITING_EVENT) {
    return { text: 'Paused by you.', lineType: 'system' }
  }
  if (job.awaitingEvent) return { text: `Waiting on ${job.awaitingEvent}`, lineType: 'system' }
  if (job.currentWorkItem) return { text: `Working on ${job.currentWorkItem}`, lineType: 'text' }
  return { text: `Running ${job.phase}…`, lineType: 'text' }
}
