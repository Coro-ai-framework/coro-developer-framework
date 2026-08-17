import { describe, expect, it } from 'vitest'
import {
  classifyToolError,
  derivePhaseAttributions,
  recordToolCall,
  recordToolResult,
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
