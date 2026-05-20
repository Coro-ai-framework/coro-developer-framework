// ── Guardrail types (script authors + dashboard) ────────────────────────────
//
// Runtime enforcement lives in `@coro/runner`. This module exposes only the
// stable contract for custom `~/.coro/guardrails/<name>.mjs` scripts.

/** Product-level events guardrails subscribe to. */
export type GuardrailOn = 'scm.create_pr' | 'scm.merge_pr' | 'propose_change' | 'tool.before'

export interface GuardrailJobSnapshot {
  id: string
  phase: string
  workflowPath?: string
  params: Record<string, unknown>
  repoSlug?: string
}

export interface GuardrailGitDiffStat {
  lines: number
  files: number
}

export interface GuardrailHelpers {
  gitDiff(args: { repoDir: string; base?: string }): Promise<GuardrailGitDiffStat>
}

export interface GuardrailContext {
  on: GuardrailOn
  toolName?: string
  toolInput: Record<string, unknown>
  job: GuardrailJobSnapshot
  workingDir: string
  repoDir?: string
  helpers: GuardrailHelpers
}

export interface GuardrailDecision {
  allow: boolean
  reason?: string
}

export type GuardrailScript = (ctx: GuardrailContext) => Promise<GuardrailDecision>
