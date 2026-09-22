/**
 * Jev decision plugin.
 *
 * Same shape as the other built-in providers: the runner core never imports
 * this module statically. `createDecisionClient` loads it only when
 * `decision.provider` selects this id. An install that has not opted in
 * never constructs it and never opens a socket.
 *
 * It is not registered in {@link BUILTIN_PLUGIN_FACTORIES}. SCM, tracker,
 * and executor plugins are job-facing and live under `plugins.installed`.
 * This one is an out-of-band classifier selected by the decision layer.
 */
import type { DecisionProvider } from '../../../clients/decision/types'
import type { DecisionSettings } from '../../../config/settings'
import { JEV_PROVIDER_ID } from './defaults'
import { JevDecisionProvider } from './provider'

export { JEV_DEFAULT_BASE_URL, JEV_DEFAULT_MODEL, JEV_LEGACY_API_KEY_ENV, JEV_PROVIDER_ID } from './defaults'
export { JevDecisionProvider } from './provider'

export function createJevDecisionProvider(settings: DecisionSettings): DecisionProvider {
  return new JevDecisionProvider(settings)
}

export const jevDecisionPlugin = {
  id: JEV_PROVIDER_ID,
  create: createJevDecisionProvider,
}
