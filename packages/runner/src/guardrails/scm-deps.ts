import type { ExternalRef } from '@coro-ai/cloud-protocol'
import type { ScmPluginRuntime } from '../plugins/types'
import type { ToolContext } from '../tools/types'
import { PluginResolutionError } from '../plugins/registry'

export type GuardrailPrApprovalStatus =
  | { ok: true; approvalCount: number; state: string }
  | { ok: false; reason: string }

/** SCM lookups injected into guardrail checks that need live PR state. */
export interface GuardrailScmDeps {
  getPrApprovalStatus?(args: {
    repo: string
    prId: number | string
    pluginId?: string
    jobParams: Record<string, unknown>
  }): Promise<GuardrailPrApprovalStatus>
}

function prRef(scm: ScmPluginRuntime, repo: string, prId: number | string): ExternalRef {
  return {
    kind: 'pull_request',
    pluginId: scm.manifest.id,
    repoKey: repo,
    externalId: String(prId),
  }
}

function resolveScmForGuardrail(
  ctx: ToolContext,
  pluginId: string | undefined,
): { ok: true; scm: ScmPluginRuntime } | { ok: false; reason: string } {
  try {
    if (pluginId) {
      return { ok: true, scm: ctx.plugins.resolveScm({ scm: pluginId }) }
    }
    const requested = typeof ctx.job.params['scm'] === 'string'
      ? (ctx.job.params['scm'] as string)
      : undefined
    return { ok: true, scm: ctx.plugins.resolveScm(requested ? { scm: requested } : {}) }
  } catch (err) {
    const msg = err instanceof PluginResolutionError
      ? err.message
      : (err instanceof Error ? err.message : String(err))
    return { ok: false, reason: `SCM plugin resolution failed: ${msg}` }
  }
}

/**
 * Build SCM helpers for guardrail checks from a live {@link ToolContext}.
 * Uses native `getPrStatus` when available, otherwise `pollPr` (GitHub MCP
 * mode exposes approvals only through polling).
 */
export function createGuardrailScmDeps(ctx: ToolContext): GuardrailScmDeps {
  return {
    getPrApprovalStatus: async args => {
      const resolved = resolveScmForGuardrail(ctx, args.pluginId)
      if (!resolved.ok) return { ok: false, reason: resolved.reason }

      const ref = prRef(resolved.scm, args.repo, args.prId)
      try {
        if (resolved.scm.getPrStatus) {
          const status = await resolved.scm.getPrStatus(ref)
          return {
            ok: true,
            approvalCount: status.approvalCount,
            state: status.state,
          }
        }
        if (resolved.scm.pollPr) {
          const snap = await resolved.scm.pollPr(ref)
          return {
            ok: true,
            approvalCount: snap.approvalCount,
            state: snap.state,
          }
        }
        return {
          ok: false,
          reason:
            `SCM plugin "${resolved.scm.manifest.id}" cannot report PR approval state. ` +
            `Call scm_get_pr_status before merging, or use a plugin with native status support.`,
        }
      } catch (err) {
        return {
          ok: false,
          reason: `Failed to read PR status: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },
  }
}
