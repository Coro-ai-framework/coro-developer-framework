import { describe, expect, it } from 'vitest'
import {
  attributionForIncoming,
  classifyToolError,
  derivePhaseAttributions,
  estimatePhaseCostUsd,
  recordToolCall,
  recordToolResult,
  sessionCostBaseline,
  stampParkReason,
  type PendingToolCall,
} from '../../src/jobs/phase-observability'
import type { PhaseUsage, ToolLedgerEntry } from '@coro-ai/cloud-protocol'

describe('derivePhaseAttributions', () => {
  it('derives the same progression the history reports used to compute inline', () => {
    expect(derivePhaseAttributions(
      [
        { phase: 'planning' },
        { phase: 'coding', workItem: 'wi-1' },
        { phase: 'coding', workItem: 'wi-1' },
        { phase: 'coding', workItem: 'wi-1' },
      ],
      { checkpointPhases: new Set(['coding']), interactive: true },
    )).toEqual(['work-item', 'work-item', 'checkpoint-resume', 'rework'])
  })

  it('keeps a recorded value even when derivation would disagree', () => {
    expect(derivePhaseAttributions(
      [
        { phase: 'coding', workItem: 'wi-1', attribution: 'work-item' },
        { phase: 'coding', workItem: 'wi-1', attribution: 'rework' },
      ],
      { checkpointPhases: new Set(['coding']), interactive: true },
    )).toEqual(['work-item', 'rework'])
  })

  it('attributes the run following a parked run as checkpoint-resume, even with no declared checkpoint', () => {
    // The gatekeeper merge that follows a `pr:approved` (or
    // `developer-input: …`) park is not a loop the agent made on its
    // own — it is the resume of that park. This holds independently of
    // the one-resume-per-checkpoint allowance, which requires the phase
    // to be a declared interactive checkpoint; here it is not.
    expect(derivePhaseAttributions(
      [
        { phase: 'review', workItem: 'w', parkReason: 'pr:approved' },
        { phase: 'review', workItem: 'w' },
      ],
    )).toEqual(['work-item', 'checkpoint-resume'])
  })

  it('still treats a genuine repeat with no preceding park as rework', () => {
    expect(derivePhaseAttributions(
      [
        { phase: 'review', workItem: 'w' },
        { phase: 'review', workItem: 'w' },
        { phase: 'review', workItem: 'w' },
      ],
    )).toEqual(['work-item', 'rework', 'rework'])
  })

  it('does not treat a park under a different work item as covering this run', () => {
    expect(derivePhaseAttributions(
      [
        { phase: 'review', workItem: 'w1', parkReason: 'pr:approved' },
        { phase: 'review', workItem: 'w2' },
      ],
    )).toEqual(['work-item', 'work-item'])
  })
})

describe('attributionForIncoming', () => {
  it('attributes an incoming run as checkpoint-resume when the prior run parked', () => {
    expect(attributionForIncoming(
      [{ phase: 'review', workItem: 'w', parkReason: 'pr:approved', attribution: 'work-item' }],
      { phase: 'review', workItem: 'w' },
      {},
    )).toBe('checkpoint-resume')
  })
})

describe('sessionCostBaseline', () => {
  it('falls back to the job-level total when no prior snapshot carries a sessionId', () => {
    // Jobs persisted before the `sessionId` field existed.
    expect(sessionCostBaseline(
      [{ costUsd: 1.99 }],
      'sess-a',
      1.99,
    )).toBe(1.99)
  })

  it('falls back to the job-level total when no sessionId is being resumed', () => {
    expect(sessionCostBaseline([{ costUsd: 1.99, sessionId: 'sess-a' }], undefined, 0)).toBe(0)
  })

  it('sums only the entries stamped with the resumed session, including $0 runs', () => {
    // The bug this replaces: a job-level total silently drops a $0 run
    // that belongs to this session, so the next run on the session
    // absorbs its real cost. Summing by sessionId includes it correctly
    // (contributing 0), and excludes cost booked under a different
    // session even though it is part of the same job-level total.
    expect(sessionCostBaseline(
      [
        { costUsd: 0.006, sessionId: 'sess-a' },
        { costUsd: 4.2, sessionId: 'sess-b' },
      ],
      'sess-a',
      4.206,
    )).toBeCloseTo(0.006, 8)
  })
})

describe('estimatePhaseCostUsd', () => {
  const tokens = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadInputTokens: 1_000_000,
    cacheCreationInputTokens: 1_000_000,
  }

  it('prices a known Claude family from its per-MTok rates', () => {
    expect(estimatePhaseCostUsd(tokens, 'claude-sonnet-4-5')).toBeCloseTo(3 + 15 + 0.3 + 3.75, 8)
  })

  it('matches the family by substring, case-insensitively', () => {
    expect(estimatePhaseCostUsd(tokens, 'Claude-Opus-4-1')).toBeCloseTo(15 + 75 + 1.5 + 18.75, 8)
  })

  it('prices an unrecognised model family at 0 rather than guessing', () => {
    expect(estimatePhaseCostUsd(tokens, 'gpt-5-codex')).toBe(0)
  })
})

describe('classifyToolError', () => {
  it('collapses known failures to a short class and drops paths', () => {
    expect(classifyToolError('Blocked Bash: operation not permitted writing /Users/me/src')).toBe('operation-not-permitted')
    expect(classifyToolError({ text: 'Error: 404 Not Found' })).toBe('404')
    expect(classifyToolError('EPERM: mkdir /tmp/foo')).toBe('eperm')
  })
})

describe('tool ledger pairing', () => {
  it('pairs call/result by tool name and records failures', () => {
    const pending: PendingToolCall[] = []
    const ledger: ToolLedgerEntry[] = []
    recordToolCall(pending, 'Bash', 1000)
    recordToolResult(pending, ledger, {
      toolName: 'Bash',
      isError: true,
      output: 'EPERM',
      endedAt: 1250,
    })
    expect(pending).toHaveLength(0)
    expect(ledger).toEqual([
      { toolName: 'Bash', success: false, durationMs: 250, errorClass: 'eperm' },
    ])
  })
})

describe('stampParkReason', () => {
  it('annotates the last snapshot of the parking phase', () => {
    const usage = [
      { phase: 'coding', costUsd: 0 } as PhaseUsage,
    ]
    const stamped = stampParkReason(usage, 'coding', 'developer-input: approve plan')
    expect(stamped[0]?.parkReason).toBe('developer-input: approve plan')
    expect(stampParkReason(stamped, 'coding', 'other')).toBe(stamped)
  })
})
