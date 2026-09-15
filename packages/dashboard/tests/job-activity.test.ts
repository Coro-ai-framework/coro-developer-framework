import { describe, expect, it } from 'vitest'
import type { LogLine } from '../src/hooks/useJobStream'
import { activityFallback, lastAgentActivity, stripActivityPrefix } from '../src/lib/job-activity'
import { PAUSED_AWAITING_EVENT } from '../src/lib/status'

function line(content: string, lineType: LogLine['lineType']): LogLine {
  return { timestamp: '2026-01-01T00:00:00.000Z', content, lineType }
}

describe('lastAgentActivity', () => {
  it('returns the newest meaningful line', () => {
    const snippet = lastAgentActivity([
      line('Phase advanced to coding', 'phase'),
      line('→ Edit src/main.go', 'tool_use'),
    ])
    expect(snippet?.text).toBe('Edit src/main.go')
    expect(snippet?.lineType).toBe('tool_use')
  })

  it('skips bookkeeping so the row never reads as noise', () => {
    const snippet = lastAgentActivity([
      line('Running the test suite', 'text'),
      line('[usage] 1200 in / 300 out', 'system'),
      line('[tool_summary] 3 files read', 'tool_summary'),
      line('[thinking] considering the retry path', 'thinking'),
    ])
    expect(snippet?.text).toBe('Running the test suite')
  })

  it('has nothing to say for an empty or noise-only stream', () => {
    expect(lastAgentActivity([])).toBeNull()
    expect(lastAgentActivity([line('[init] session started', 'system')])).toBeNull()
  })

  it('strips markers and collapses whitespace', () => {
    expect(stripActivityPrefix('[error]  something   broke')).toBe('something broke')
    expect(stripActivityPrefix('→ scm_list_files')).toBe('scm_list_files')
    expect(stripActivityPrefix('⏳ still running')).toBe('still running')
  })
})

describe('activityFallback', () => {
  const base = { status: 'coding', phase: 'coding' } as const

  it('prefers the escalation message when a run needs a human', () => {
    expect(activityFallback({
      ...base,
      status: 'escalated',
      escalationMessage: 'Cannot reach the tracker',
    }).text).toBe('Cannot reach the tracker')
  })

  it('distinguishes a developer pause from an agent park', () => {
    expect(activityFallback({ ...base, status: 'awaiting-developer-input', awaitingEvent: PAUSED_AWAITING_EVENT }).text)
      .toBe('Paused by you.')
    expect(activityFallback({ ...base, status: 'awaiting-pr-merge', awaitingEvent: 'pr-merge: 482' }).text)
      .toBe('Waiting on pr-merge: 482')
  })

  it('falls back to the work item, then the phase', () => {
    expect(activityFallback({ ...base, currentWorkItem: 'rate limiting' }).text)
      .toBe('Working on rate limiting')
    expect(activityFallback(base).text).toBe('Running coding…')
    expect(activityFallback({ ...base, status: 'complete' }).text).toBe('All phases complete.')
  })
})
