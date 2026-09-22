import type { DecisionAsk, DecisionProvider, DecisionResult } from './types'

export const UNAVAILABLE_REASON =
  'Decision layer not configured (decision.mode is off or no API key)'

class UnavailableDecisionProvider implements DecisionProvider {
  readonly providerId = 'none'

  async ask(_req: DecisionAsk): Promise<DecisionResult> {
    return { available: false, reason: UNAVAILABLE_REASON }
  }
}

/** Frozen singleton so call sites never need a null check. */
export const unavailableDecisionProvider: DecisionProvider = new UnavailableDecisionProvider()
