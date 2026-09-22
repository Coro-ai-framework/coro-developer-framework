import { describe, expect, it } from 'vitest'
import { shouldParkForOverseer } from '../../src/overseer'

describe('overseer hook park decision', () => {
  const flagged = { called: true, flag: true, reason: 'off track' }

  it('does not park in shadow, on non-interactive jobs, or after an approval waiver', () => {
    expect(shouldParkForOverseer({
      outcome: flagged, interactive: true, onFlag: 'park', mode: 'live', phase: 'coding',
    })).toBe(true)
    expect(shouldParkForOverseer({
      outcome: flagged, interactive: true, onFlag: 'park', mode: 'shadow', phase: 'coding',
    })).toBe(false)
    expect(shouldParkForOverseer({
      outcome: flagged, interactive: false, onFlag: 'park', mode: 'live', phase: 'coding',
    })).toBe(false)
    expect(shouldParkForOverseer({
      outcome: flagged, interactive: true, onFlag: 'park', mode: 'live',
      approvedAdvanceFromPhase: 'coding', phase: 'coding',
    })).toBe(false)
  })
})
