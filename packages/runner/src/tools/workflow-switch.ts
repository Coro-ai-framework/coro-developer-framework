// ── switch_workflow ──────────────────────────────────────────────────────────
//
// Generic, in-place workflow lane change. This is the harness primitive that
// powers both `convert_to_campaign` (legacy planner triage → campaign lane)
// and the new lane router pattern where the planner picks fast / standard /
// deep based on the work-item shape.
//
// Design rules (locked Plan v3):
//   1. Path-based admission, not an allowlist. The target workflow must
//      exist in the resolved overlay (base / tenant / repo). Any user-
//      supplied workflow that resolves through the standard discovery
//      walk is acceptable.
//   2. Refused if `params.epicAllowed === false` AND the target is the
//      campaign workflow. Children of an existing campaign cannot recurse
//      into another campaign.
//   3. No-op + warning if the target equals the current workflow.
//   4. Shallow-merge `paramsPatch` into `job.params`; preserves all other
//      job context (sessionId is reset, since the new workflow's prompt
//      will be different).
//   5. Phase reset rules:
//        - `toPhase` if provided AND it is a valid phase of the target
//          workflow → use it (caller knows what they're doing, e.g. mid-
//          workflow re-entry on a resumed lane);
//        - else use the target workflow's `initial_phase`.
//   6. Append a {@link WorkflowSwitchEntry} to `job.workflowPathHistory`
//      so the dashboard / evaluator can audit lane changes.
//   7. Set `signals.nextPhase = <newPhase>` so the runner ends the current
//      turn cleanly and re-enters at the new lane on the next loop pass.
//      The runner reloads the workflow config when it detects that
//      `liveJob.workflowPath` has drifted from the cached config.

import type { ToolContext, PhaseSignals } from './types'
import {
  CAMPAIGN_WORKFLOW_PATH,
  isEpicAllowed,
  type Job,
  type WorkflowSwitchEntry,
} from '../jobs/types'
import { loadWorkflowConfigFromRoots } from '../workflow-parser'

export interface SwitchWorkflowArgs {
  /** Workflow markdown path, relative to the intelligence root (e.g. `workflows/job-fast/workflow.md`). */
  workflowPath: string
  /** Optional shallow merge into `job.params`. */
  paramsPatch?: Record<string, unknown>
  /** Required: short audit string ("planner: small change → fast lane"). */
  reason: string
  /** Optional explicit start phase on the new workflow. Must be declared by it. */
  toPhase?: string
  /**
   * Internal marker so {@link convertToCampaign} can record provenance
   * accurately. External callers should leave this unset; it defaults
   * to `'switch_workflow'`.
   */
  by?: WorkflowSwitchEntry['by']
}

export interface SwitchWorkflowResult {
  ok: true
  workflowPath: string
  phase: string
  by: WorkflowSwitchEntry['by']
  /** Set when the target equals the current workflow — the call was a no-op. */
  noop?: true
}

export async function switchWorkflow(
  args: SwitchWorkflowArgs,
  ctx: ToolContext,
  signals: PhaseSignals,
): Promise<SwitchWorkflowResult> {
  const target = (args.workflowPath ?? '').trim()
  if (!target) {
    throw new Error('switch_workflow requires a non-empty workflowPath.')
  }
  if (!args.reason || !args.reason.trim()) {
    throw new Error('switch_workflow requires a non-empty reason (used for the audit log).')
  }

  // Rule 3: same-workflow no-op. We still log + return so the caller can
  // surface the warning to the user / dashboard rather than silently
  // succeeding with no state change.
  if (target === ctx.job.workflowPath) {
    await ctx.stateBackend.appendLog(
      ctx.job.id,
      `[switch_workflow] no-op — already on ${target} (reason: ${args.reason})`,
    )
    return {
      ok: true,
      workflowPath: ctx.job.workflowPath,
      phase: ctx.job.phase,
      by: args.by ?? 'switch_workflow',
      noop: true,
    }
  }

  // Rule 2: epic recursion guard.
  if (target === CAMPAIGN_WORKFLOW_PATH && !isEpicAllowed(ctx.job)) {
    throw new Error(
      'switch_workflow refused: this job has params.epicAllowed=false. ' +
        'Children spawned from a campaign cannot themselves become campaigns. ' +
        'Pick a non-campaign workflow.',
    )
  }

  // Rule 1: path-based admission. The target must resolve via the standard
  // overlay walk (jobIntelligenceDir, then base layer). Anything else
  // would have meant the agent fabricated a path or referenced a workflow
  // that the tenant/repo overlay never installed.
  const searchRoots = [ctx.jobIntelligenceDir, ctx.settings.paths.baseLayerDir].filter(
    (r): r is string => Boolean(r),
  )
  const resolved = await loadWorkflowConfigFromRoots(target, searchRoots, ctx.logger)
  if (!resolved) {
    throw new Error(
      `switch_workflow refused: workflow '${target}' was not found in any layer. ` +
        `Searched [${searchRoots.join(', ')}]. ` +
        `Confirm the path is relative to the intelligence root (e.g. "workflows/job/workflow.md").`,
    )
  }

  // Rule 5: phase reset.
  let nextPhase: string
  if (args.toPhase) {
    const phaseExists = resolved.config.phases.some(p => p.name === args.toPhase)
    if (!phaseExists) {
      throw new Error(
        `switch_workflow refused: phase '${args.toPhase}' is not declared in ` +
          `workflow '${target}'. Declared phases: ` +
          `[${resolved.config.phases.map(p => p.name).join(', ')}].`,
      )
    }
    nextPhase = args.toPhase
  } else {
    nextPhase = resolved.config.initialPhase
  }

  // Rule 4: shallow-merge params.
  const params = args.paramsPatch
    ? { ...ctx.job.params, ...args.paramsPatch }
    : ctx.job.params

  // Rule 6: append history entry.
  const by: WorkflowSwitchEntry['by'] = args.by ?? 'switch_workflow'
  const entry: WorkflowSwitchEntry = {
    at: new Date().toISOString(),
    from: ctx.job.workflowPath,
    to: target,
    fromPhase: ctx.job.phase,
    toPhase: nextPhase,
    reason: args.reason.trim(),
    by,
  }
  const history: WorkflowSwitchEntry[] = [...(ctx.job.workflowPathHistory ?? []), entry]

  await ctx.stateBackend.updateJob(ctx.job.id, {
    workflowPath: target,
    phase: nextPhase,
    status: nextPhase,
    params,
    workflowPathHistory: history,
    // Refresh the cached phase list so the dashboard's workflow strip
    // reflects the new pipeline (including not-yet-started ghost
    // phases) immediately after the switch.
    workflowPhases: resolved.config.phases.map(p => ({
      name: p.name,
      status: p.status,
      ...(p.interactiveCheckpoint ? { interactiveCheckpoint: true } : {}),
    })),
    // Force a fresh Claude session — the new workflow has a different
    // system prompt / agent role, so resuming the prior transcript would
    // confuse the model.
    sessionId: undefined,
  })
  ctx.job = (await ctx.stateBackend.getJob(ctx.job.id)) as Job

  await ctx.stateBackend.appendLog(
    ctx.job.id,
    `[switch_workflow] ${entry.from} (${entry.fromPhase}) → ${entry.to} (${entry.toPhase}) — ${entry.reason}`,
  )

  // Rule 7: end this turn cleanly. The runner will detect that
  // `workflowPath` changed and reload the workflow config before
  // dispatching `nextPhase`.
  signals.nextPhase = nextPhase

  ctx.logger.info(
    {
      jobId: ctx.job.id,
      from: entry.from,
      to: entry.to,
      fromPhase: entry.fromPhase,
      toPhase: entry.toPhase,
      by: entry.by,
      resolvedFrom: resolved.resolvedFrom,
    },
    'Job workflow switched',
  )

  return {
    ok: true,
    workflowPath: target,
    phase: nextPhase,
    by,
  }
}
