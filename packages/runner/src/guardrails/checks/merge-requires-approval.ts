import type { GuardrailCheckFn } from '../types'
import type { GuardrailScmDeps } from '../scm-deps'

export interface MergeRequiresApprovalConfig {
  /** Minimum human approvals required (default 1). */
  minApprovals?: number
}

function parsePrId(toolInput: Record<string, unknown>): number | string | undefined {
  const raw = toolInput.prId ?? toolInput.pull_number ?? toolInput.pullNumber
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim().length > 0) return raw
  return undefined
}

function parseRepo(toolInput: Record<string, unknown>, jobRepoSlug?: string): string | undefined {
  const raw = toolInput.repo ?? toolInput.repoSlug ?? jobRepoSlug
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined
}

export function createMergeRequiresApprovalCheck(
  scmDeps: GuardrailScmDeps = {},
): GuardrailCheckFn {
  return async (rule, ctx) => {
    const cfg = (rule.config ?? {}) as MergeRequiresApprovalConfig
    const minApprovals = typeof cfg.minApprovals === 'number' && cfg.minApprovals >= 0
      ? cfg.minApprovals
      : 1

    const prId = parsePrId(ctx.toolInput)
    const repo = parseRepo(ctx.toolInput, ctx.job.repoSlug)
    const pluginId = typeof ctx.toolInput.pluginId === 'string'
      ? ctx.toolInput.pluginId
      : undefined

    if (prId === undefined) {
      return {
        allow: false,
        reason: 'PR id is required to merge (pass prId in scm_merge_pr).',
      }
    }
    if (!repo) {
      return {
        allow: false,
        reason: 'Repository slug is required to verify PR approvals before merge.',
      }
    }

    const fetch = scmDeps.getPrApprovalStatus
    if (!fetch) {
      return {
        allow: false,
        reason:
          'Cannot verify PR approvals before merge (guardrail SCM helpers not configured). ' +
          'Call scm_get_pr_status and retry only when approvalCount meets your policy.',
      }
    }

    const status = await fetch({
      repo,
      prId,
      pluginId,
      jobParams: ctx.job.params,
    })

    if (!status.ok) {
      return { allow: false, reason: status.reason }
    }

    if (status.state === 'merged') {
      return {
        allow: false,
        reason: 'PR is already merged.',
      }
    }
    if (status.state === 'declined' || status.state === 'superseded') {
      return {
        allow: false,
        reason: `PR is ${status.state} and cannot be merged.`,
      }
    }

    if (status.approvalCount < minApprovals) {
      return {
        allow: false,
        reason:
          `PR has ${status.approvalCount} approval(s); at least ${minApprovals} human approval(s) ` +
          `required before merge. Wait for reviewers to approve (await_event pr:approved) or call ` +
          `scm_get_pr_status to confirm ground truth, then retry scm_merge_pr.`,
      }
    }

    return { allow: true }
  }
}
