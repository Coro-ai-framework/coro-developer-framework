import type { GuardrailOn } from './types'

/** Structured denial passed to the activity-log callback. */
export interface GuardrailDenialRecord {
  ruleId: string
  on: GuardrailOn
  toolName?: string
  /** Check-specific detail (shown to the agent and in the job log). */
  detail: string
}

/** Human-facing reason returned to the agent / tool boundary. */
export function formatGuardrailAgentReason(
  rule: { id: string; title?: string; check: string },
  detail: string,
): string {
  return `Guardrail "${rule.id}" (${rule.title ?? rule.check}): ${detail}`
}

/**
 * Activity-log line for a guardrail denial. Parsed by the dashboard as `lineType: guardrail`.
 *
 * Example: `[guardrail] pr-diff-size blocked mcp__coro__scm_create_pr: Cannot evaluate…`
 */
export function formatGuardrailDenialLine(entry: GuardrailDenialRecord): string {
  const target = entry.toolName?.trim() || entry.on
  const detail = entry.detail.trim() || 'Blocked.'
  return `[guardrail] ${entry.ruleId} blocked ${target}: ${detail}`
}
