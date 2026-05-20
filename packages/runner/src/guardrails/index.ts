export {
  GuardrailEngine,
  buildGuardrailContext,
} from './engine'
export {
  loadBundledGuardrailsFile,
  resolveGuardrails,
  diffOverridesFromBundled,
} from './merge'
import type { LocalConfig } from '../config/local-config'
import { GuardrailEngine } from './engine'
import { resolveGuardrails } from './merge'

/** Build an engine from on-disk config (bundled defaults + overrides). */
export function createGuardrailEngine(config?: LocalConfig | null): GuardrailEngine {
  const { resolved } = resolveGuardrails(config?.guardrails ?? null)
  return GuardrailEngine.fromResolved(resolved)
}
export { getBundledGuardrailsDefaultsPath } from './bundled-path'
export type {
  EffectiveGuardrailRule,
  GuardrailRuleSpec,
  GuardrailRuleOverride,
  GuardrailsConfigOverride,
  GuardrailsFile,
  ResolvedGuardrails,
} from './types'
export { SCM_CREATE_PR_TOOL_NAMES } from './types'
