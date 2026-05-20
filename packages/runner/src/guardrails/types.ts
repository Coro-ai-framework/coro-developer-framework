import type {
  GuardrailContext,
  GuardrailDecision,
  GuardrailOn,
} from '@coro/plugin-sdk'

export type { GuardrailContext, GuardrailDecision, GuardrailOn }

/** Rule row as stored in bundled defaults or user overrides. */
export interface GuardrailRuleSpec {
  id: string
  title?: string
  description?: string
  enabled?: boolean
  on: GuardrailOn
  check: string
  config?: Record<string, unknown>
  during?: string[]
  workflows?: string[]
  lanes?: string[]
  script?: string
}

export interface GuardrailsFile {
  enabled?: boolean
  rules: GuardrailRuleSpec[]
}

/** Partial rule rows stored in ~/.coro/config.json (merged by `id`). */
export interface GuardrailRuleOverride {
  id: string
  title?: string
  description?: string
  enabled?: boolean
  on?: GuardrailOn
  check?: string
  config?: Record<string, unknown>
  during?: string[]
  workflows?: string[]
  lanes?: string[]
  script?: string
}

export interface GuardrailsConfigOverride {
  enabled?: boolean
  rules?: GuardrailRuleOverride[]
}

export type GuardrailRuleSource = 'bundled' | 'override' | 'custom'

export interface EffectiveGuardrailRule extends GuardrailRuleSpec {
  source: GuardrailRuleSource
  /** Present when `check === 'script'`. */
  scriptFileExists?: boolean
}

export interface ResolvedGuardrails {
  enabled: boolean
  rules: EffectiveGuardrailRule[]
  scriptsDir: string
}

export type GuardrailCheckFn = (
  rule: EffectiveGuardrailRule,
  ctx: GuardrailContext,
) => Promise<GuardrailDecision>

/** Tool names that represent `scm.create_pr` at the executor boundary. */
export const SCM_CREATE_PR_TOOL_NAMES = new Set([
  'mcp__coro__scm_create_pr',
])

/** Tool names that represent `scm.merge_pr` at the executor boundary. */
export const SCM_MERGE_PR_TOOL_NAMES = new Set([
  'mcp__coro__scm_merge_pr',
])

/** Tool names that represent `propose_change` at the executor boundary. */
export const PROPOSE_CHANGE_TOOL_NAMES = new Set([
  'mcp__coro__propose_change',
])
