import path from 'node:path'
import type { Job } from '@coro-ai/cloud-protocol'
import type { GuardrailContext, GuardrailDecision, GuardrailOn } from './types'
import {
  type EffectiveGuardrailRule,
  type ResolvedGuardrails,
  SCM_CREATE_PR_TOOL_NAMES,
  SCM_MERGE_PR_TOOL_NAMES,
  PROPOSE_CHANGE_TOOL_NAMES,
} from './types'
import { checkPrDescription } from './checks/pr-description'
import { checkPrDiffSize, gitDiffStat } from './checks/pr-diff-size'
import { createMergeRequiresApprovalCheck } from './checks/merge-requires-approval'
import { checkProposalMarkdownOnly } from './checks/proposal-markdown-only'
import { createScriptCheck } from './checks/script'
import type { GuardrailCheckFn } from './types'
import type { GuardrailScmDeps } from './scm-deps'
import {
  formatGuardrailAgentReason,
  formatGuardrailDenialLine,
} from './denial-log'

function matchesGlob(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

function ruleMatchesScope(rule: EffectiveGuardrailRule, ctx: GuardrailContext): boolean {
  if (rule.during && rule.during.length > 0 && !rule.during.includes(ctx.job.phase)) {
    return false
  }
  const workflowPath = ctx.job.workflowPath ?? ''
  if (rule.workflows && rule.workflows.length > 0) {
    if (!workflowPath || !rule.workflows.some(p => matchesGlob(p, workflowPath))) {
      return false
    }
  }
  const lane = typeof ctx.job.params.lane === 'string' ? ctx.job.params.lane : undefined
  if (rule.lanes && rule.lanes.length > 0) {
    if (!lane || !rule.lanes.includes(lane)) {
      return false
    }
  }
  return true
}

export interface GuardrailEngineOptions {
  scm?: GuardrailScmDeps
  /**
   * When set, each denial is written to the job activity log via
   * {@link formatGuardrailDenialLine} (`[guardrail]` prefix).
   */
  activityLog?: (line: string) => void | Promise<void>
}

export class GuardrailEngine {
  private readonly checks: Map<string, GuardrailCheckFn>
  private readonly activityLog?: (line: string) => void | Promise<void>

  constructor(
    private readonly resolved: ResolvedGuardrails,
    options: GuardrailEngineOptions = {},
  ) {
    this.activityLog = options.activityLog
    this.checks = new Map([
      ['pr-description', checkPrDescription],
      ['pr-diff-size', checkPrDiffSize],
      ['merge-requires-approval', createMergeRequiresApprovalCheck(options.scm)],
      ['proposal-markdown-only', checkProposalMarkdownOnly],
      ['script', createScriptCheck(resolved.scriptsDir)],
    ])
  }

  static fromResolved(
    resolved: ResolvedGuardrails,
    options?: GuardrailEngineOptions,
  ): GuardrailEngine {
    return new GuardrailEngine(resolved, options)
  }

  isEnabled(): boolean {
    return this.resolved.enabled
  }

  getEffectiveRules(): EffectiveGuardrailRule[] {
    return this.resolved.rules
  }

  /**
   * Evaluate all rules for a product event. Returns the first denial or allow.
   */
  async evaluate(on: GuardrailOn, ctx: GuardrailContext): Promise<GuardrailDecision> {
    if (!this.resolved.enabled) return { allow: true }

    const matching = this.resolved.rules.filter(
      r => r.enabled && r.on === on && ruleMatchesScope(r, ctx),
    )

    for (const rule of matching) {
      const fn = this.checks.get(rule.check)
      if (!fn) {
        return this.deny(rule, on, ctx, {
          detail:
            `references unknown check "${rule.check}". ` +
            `Fix ~/.coro/config.json or update the shipped defaults.`,
        })
      }
      const decision = await fn(rule, ctx)
      if (!decision.allow) {
        return this.deny(rule, on, ctx, {
          detail: decision.reason ?? 'Blocked this action.',
        })
      }
    }

    return { allow: true }
  }

  private async deny(
    rule: EffectiveGuardrailRule,
    on: GuardrailOn,
    ctx: GuardrailContext,
    args: { detail: string },
  ): Promise<GuardrailDecision> {
    const detail = args.detail.trim() || 'Blocked this action.'
    if (this.activityLog) {
      await this.activityLog(formatGuardrailDenialLine({
        ruleId: rule.id,
        on,
        toolName: ctx.toolName,
        detail,
      }))
    }
    return {
      allow: false,
      ruleId: rule.id,
      on,
      reason: formatGuardrailAgentReason(rule, detail),
    }
  }

  /**
   * Map a tool call to guardrail events and evaluate.
   */
  async evaluateToolBefore(args: {
    toolName: string
    toolInput: Record<string, unknown>
    job: Job
    workingDir: string
  }): Promise<GuardrailDecision> {
    const ctx = buildGuardrailContext({
      on: 'tool.before',
      toolName: args.toolName,
      toolInput: args.toolInput,
      job: args.job,
      workingDir: args.workingDir,
    })

    if (SCM_CREATE_PR_TOOL_NAMES.has(args.toolName)) {
      const prDecision = await this.evaluate('scm.create_pr', {
        ...ctx,
        on: 'scm.create_pr',
      })
      if (!prDecision.allow) return prDecision
    }

    if (SCM_MERGE_PR_TOOL_NAMES.has(args.toolName)) {
      const mergeDecision = await this.evaluate('scm.merge_pr', {
        ...ctx,
        on: 'scm.merge_pr',
      })
      if (!mergeDecision.allow) return mergeDecision
    }

    if (PROPOSE_CHANGE_TOOL_NAMES.has(args.toolName)) {
      const proposalDecision = await this.evaluate('propose_change', {
        ...ctx,
        on: 'propose_change',
      })
      if (!proposalDecision.allow) return proposalDecision
    }

    return this.evaluate('tool.before', ctx)
  }
}

/** Directory name under the job working dir where the target repo checkout lives. */
export function resolveGuardrailRepoDir(args: {
  workingDir: string
  toolInput: Record<string, unknown>
  params: Record<string, unknown>
}): string | undefined {
  const raw =
    args.toolInput.repo ??
    args.toolInput.repoSlug ??
    args.params.targetRepo ??
    args.params.repoSlug ??
    args.params.repo
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  return path.join(args.workingDir, raw.trim())
}

export function buildGuardrailContext(args: {
  on: GuardrailOn
  toolName?: string
  toolInput: Record<string, unknown>
  job: Job
  workingDir: string
}): GuardrailContext {
  const params = (args.job.params ?? {}) as Record<string, unknown>
  const repoSlug = typeof params.repoSlug === 'string' ? params.repoSlug : undefined
  const repoDir = resolveGuardrailRepoDir({
    workingDir: args.workingDir,
    toolInput: args.toolInput,
    params,
  })

  return {
    on: args.on,
    toolName: args.toolName,
    toolInput: args.toolInput,
    job: {
      id: args.job.id,
      phase: args.job.phase,
      workflowPath: args.job.workflowPath,
      params,
      repoSlug,
    },
    workingDir: args.workingDir,
    repoDir,
    helpers: {
      gitDiff: ({ repoDir, base, head }: { repoDir: string; base?: string; head?: string }) =>
        gitDiffStat(repoDir, base, head),
    },
  }
}
