import { describe, expect, it } from 'vitest'
import { readOnTrack } from '../src/lib/on-track'
import type { DecisionRecord } from '../src/types'

function record(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: 'dec-1',
    site: 'overseer',
    at: '2026-09-22T00:00:00Z',
    phase: 'coding',
    mode: 'shadow',
    model: 'jev-1.13.0',
    latencyMs: 80,
    inputTokens: 12,
    answers: {
      breach: {
        type: 'choice',
        choice: 'obligation[0]',
        confidence: 0.36,
        probabilities: { 'obligation[0]': 0.36, none: 0.4 },
      },
      off_track: { type: 'noul', noul: 0.85 },
      severity: { type: 'score', score: 1.9, confidence: 0.63, probabilities: {} },
      blocked: { type: 'noul', noul: 0.43 },
    },
    ...over,
  }
}

describe('readOnTrack', () => {
  it('reads a healthy check as on track, without the raw scores', () => {
    const readout = readOnTrack([record()])
    expect(readout?.label).toBe('On track')
    expect(readout?.confidence).toBe(85)
    expect(readout?.summary).toMatch(/doing what it set out to do/)
    expect(readout?.lines).toEqual([
      { label: 'Goal', value: 'Still on it' },
      { label: 'Requirements', value: 'Nothing we’re sure was missed' },
      { label: 'Stuck', value: 'No' },
    ])
    expect(JSON.stringify(readout)).not.toMatch(/obligation\[|off_track|noul|0\.85/)
  })

  it('reads a low on-goal score as off track', () => {
    const readout = readOnTrack([
      record({
        answers: {
          off_track: { type: 'noul', noul: 0.2 },
          breach: { type: 'choice', choice: 'none', confidence: 0.9, probabilities: { none: 0.9 } },
          blocked: { type: 'noul', noul: 0.1 },
        },
        flagReason: 'drift',
      }),
    ])
    expect(readout?.label).toBe('Off track')
    expect(readout?.confidence).toBe(20)
    expect(readout?.lines[0]).toEqual({ label: 'Goal', value: 'Drifting' })
  })

  it('uses the rounded percent as the only input to the label', () => {
    const unclear = readOnTrack([
      record({
        answers: { off_track: { type: 'noul', noul: 0.55 } },
        flagReason: 'something else looked off',
      }),
    ])
    expect(unclear?.confidence).toBe(55)
    expect(unclear?.label).toBe('Needs a look')

    const healthyDespiteAFlag = readOnTrack([
      record({ flagReason: 'a weak miss was noted' }),
    ])
    expect(healthyDespiteAFlag?.confidence).toBe(85)
    expect(healthyDespiteAFlag?.label).toBe('On track')
  })

  it('ignores checks that are not about the run being on track', () => {
    expect(readOnTrack([record({ site: 'wake-gate', answers: {} })])).toBeNull()
  })
})
