import type { Settings } from '../../config/settings'
import { JEV_PROVIDER_ID } from '../../plugins/builtin/jev/defaults'
import type { DecisionProvider } from './types'
import { unavailableDecisionProvider } from './unavailable'

export type {
  ChoiceQuestion,
  DecisionAsk,
  DecisionProvider,
  DecisionResult,
  DecisionSuccess,
  DecisionUnavailable,
  NoulQuestion,
  ScoreQuestion,
} from './types'
export { unavailableDecisionProvider } from './unavailable'
export { recordDecision, DECISION_RECORD_CAP } from './record'

/**
 * Construct the process-wide decision client.
 *
 * Returns a permanently unavailable stub when the install has not opted in,
 * so call sites never need a null check and never open a socket. The vendor
 * plugin is loaded only when `decision.provider` names one this process knows.
 */
export async function createDecisionClient(settings: Settings): Promise<DecisionProvider> {
  const config = settings.decision
  if (!config) return unavailableDecisionProvider
  if (config.provider === JEV_PROVIDER_ID) {
    const { createJevDecisionProvider } = await import('../../plugins/builtin/jev')
    return createJevDecisionProvider(config)
  }
  return unavailableDecisionProvider
}
