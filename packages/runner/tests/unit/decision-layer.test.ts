import { describe, expect, it, vi } from 'vitest'
import { createDecisionLayer } from '../../src/decision/layer'
import type { DecisionProvider } from '../../src/clients/decision'

function throwingProvider(): DecisionProvider {
  return {
    providerId: 'jev',
    ask: vi.fn(async () => {
      throw new Error('should not be called')
    }),
  }
}

describe('createDecisionLayer', () => {
  it('does nothing when the install has not opted in', async () => {
    const decision = throwingProvider()
    const layer = createDecisionLayer({} as never, decision)
    expect(layer.enabled).toBe(false)
    expect(await layer.kickoffExtras({} as never)).toBe('')
    expect(await layer.afterPhase({} as never)).toEqual({ consulted: false, park: false })
    expect(await layer.screenInbound({ events: [{ eventKey: 'pr:comment', payload: {} }] } as never)).toEqual({
      resume: true,
      warnings: [],
    })
    expect(decision.ask).not.toHaveBeenCalled()
  })

  it('does nothing when the client was not constructed', async () => {
    const layer = createDecisionLayer({ decision: { mode: 'live' } } as never, undefined)
    expect(layer.enabled).toBe(false)
    expect(await layer.screenInbound({ events: [] } as never)).toEqual({ resume: true, warnings: [] })
  })
})
