// ── Campaign tools ───────────────────────────────────────────────────────────
//
// These MCP tools own the campaign half of the issue-list architecture. The
// design split is deliberate:
//
//   convert_to_campaign        — called by the regular planner agent during
//                                its triage step when the work is too big
//                                for a single Job. Promotes the active Job
//                                in place: switches `workflowPath` to the
//                                campaign workflow, resets `phase`, and
//                                seeds an empty `campaignChildren[]`.
//
//   campaign_register_child    — called by the campaign-planner once per
//                                child issue. Appends to `campaignChildren[]`
//                                with a `dependsOn` graph the dispatcher
//                                later honours.
//
//   campaign_finalize          — called by the campaign-planner when the
//                                breakdown is complete. Runs cycle detection
//                                over the dependency graph, then ends the
//                                turn so the runner advances to coordinating.
//
//   campaign_status            — read-only aggregation used by the
//                                campaign-evaluator and the dashboard.
//
//   campaign_skip_child /
//   campaign_rerun_child /
//   campaign_cancel_child      — live-control mutations available to the
//                                evaluator and to humans (via HTTP).
//
// These tools never dispatch child Jobs themselves; that is the dispatcher's
// coordinator hook. Keeping spawn responsibility in one place is the only
// way race-free dependency resolution stays sane.

import type { ToolContext, PhaseSignals } from './types'
import {
  CAMPAIGN_WORKFLOW_PATH,
  STATUS_AWAITING_CHILDREN,
  STATUS_CANCELLED,
  STATUS_COMPLETE,
  STATUS_ESCALATED,
  STATUS_FAILED,
  type CampaignChild,
  type CampaignChildStatus,
  type Job,
  type TrackerRef,
} from '@coro-ai/cloud-protocol'
import {
  cancelledJobPatch,
  isCampaignJob,
  isEpicAllowed,
  isSatisfiedChildStatus,
  isStoppedStatus,
  isTerminalChildStatus,
} from '../jobs/helpers'
import { switchWorkflow } from './workflow-switch'

// ── convert_to_campaign ──────────────────────────────────────────────────────

export interface ConvertToCampaignArgs {
  /** Short human-readable epic title — surfaces on the campaign job and PR/issue copy. */
  title: string
  /** Long-form description handed to the campaign-planner agent. */
  description: string
  /** Optional pointer to an already-created tracker epic; the campaign-planner can also create one later. */
  trackerEpicRef?: TrackerRef
}

export async function convertToCampaign(
  args: ConvertToCampaignArgs,
  ctx: ToolContext,
  signals: PhaseSignals,
): Promise<{ ok: true; campaignJobId: string; nextPhase: string }> {
  if (!isEpicAllowed(ctx.job)) {
    throw new Error(
      'convert_to_campaign refused: this job has params.epicAllowed=false. ' +
        'Children spawned from a campaign cannot themselves become campaigns ' +
        '— keep the breakdown flat. Implement the work as a regular job.',
    )
  }
  if (isCampaignJob(ctx.job)) {
    throw new Error(
      'convert_to_campaign refused: this job is already a campaign. ' +
        'Use campaign_register_child to add issues to its breakdown.',
    )
  }
  if (!args.title || !args.title.trim()) {
    throw new Error('convert_to_campaign requires a non-empty title.')
  }
  if (!args.description || !args.description.trim()) {
    throw new Error('convert_to_campaign requires a non-empty description.')
  }

  // Delegate the actual workflow swap to the generic switch_workflow
  // primitive — same plumbing for params merge, history append, session
  // reset, and the next-phase signal. We layer the campaign-specific
  // initialisation (`campaignChildren: []`) on top.
  const switchResult = await switchWorkflow(
    {
      workflowPath: CAMPAIGN_WORKFLOW_PATH,
      paramsPatch: {
        campaignTitle: args.title,
        campaignDescription: args.description,
        ...(args.trackerEpicRef ? { trackerEpicRef: args.trackerEpicRef } : {}),
      },
      reason: `convert_to_campaign: ${args.title}`,
      by: 'convert_to_campaign',
    },
    ctx,
    signals,
  )

  await ctx.stateBackend.updateJob(ctx.job.id, {
    campaignChildren: [],
  })
  ctx.job = (await ctx.stateBackend.getJob(ctx.job.id)) as Job

  await ctx.stateBackend.appendLog(
    ctx.job.id,
    `[convert_to_campaign] Promoted to campaign — title="${args.title}". ` +
      `Workflow switched to ${CAMPAIGN_WORKFLOW_PATH}, phase=${switchResult.phase}.`,
  )

  ctx.logger.info(
    {
      jobId: ctx.job.id,
      title: args.title,
      trackerEpicRef: args.trackerEpicRef ?? null,
    },
    'Job promoted to campaign',
  )

  return { ok: true, campaignJobId: ctx.job.id, nextPhase: switchResult.phase }
}

// ── campaign_register_child ──────────────────────────────────────────────────

export interface CampaignRegisterChildArgs {
  name: string
  description: string
  /** Seed params for the dispatched child Job. The dispatcher injects `epicAllowed:false` and `campaignParentId` automatically. */
  params?: Record<string, unknown>
  /** Names of other already-registered children this one is blocked on. */
  dependsOn?: string[]
  trackerRef?: TrackerRef
}

export async function campaignRegisterChild(
  args: CampaignRegisterChildArgs,
  ctx: ToolContext,
): Promise<{ ok: true; name: string; total: number }> {
  if (!isCampaignJob(ctx.job)) {
    throw new Error(
      'campaign_register_child refused: this job is not a campaign. ' +
        'Call convert_to_campaign first (or run campaign-planning on a campaign job).',
    )
  }
  if (!args.name || !/^[a-zA-Z0-9._-]{1,64}$/.test(args.name)) {
    throw new Error(
      `Invalid child name "${args.name}". Names must be 1-64 chars of [a-zA-Z0-9._-]. ` +
        `They appear in branch suffixes and dependsOn references — keep them short and slug-like.`,
    )
  }
  if (!args.description || !args.description.trim()) {
    throw new Error(`campaign_register_child requires a non-empty description for "${args.name}".`)
  }

  const job = (await ctx.stateBackend.getJob(ctx.job.id)) as Job
  const children = job.campaignChildren ?? []

  if (children.some(c => c.name === args.name)) {
    throw new Error(
      `Child "${args.name}" is already registered on this campaign. ` +
        `Names must be unique within a campaign.`,
    )
  }

  const dependsOn = args.dependsOn ?? []
  // Dangling-dep validation. We allow forward references at registration
  // time (planner may register out of order) BUT every dependency must
  // resolve by the time `campaign_finalize` runs. The check is duplicated
  // there — we still surface obvious typos here as a courtesy.
  for (const dep of dependsOn) {
    if (dep === args.name) {
      throw new Error(`Child "${args.name}" cannot depend on itself.`)
    }
  }

  const child: CampaignChild = {
    name: args.name,
    description: args.description,
    params: args.params ?? {},
    dependsOn,
    status: 'pending',
    ...(args.trackerRef ? { trackerRef: args.trackerRef } : {}),
  }

  const updated = [...children, child]
  await ctx.stateBackend.updateJob(ctx.job.id, { campaignChildren: updated })
  ctx.job = (await ctx.stateBackend.getJob(ctx.job.id)) as Job

  await ctx.stateBackend.appendLog(
    ctx.job.id,
    `[campaign] Registered child "${args.name}" ` +
      `(deps=[${dependsOn.join(', ')}]${args.trackerRef ? `, tracker=${args.trackerRef.key}` : ''})`,
  )

  return { ok: true, name: args.name, total: updated.length }
}

// ── campaign_finalize ────────────────────────────────────────────────────────

export async function campaignFinalize(
  ctx: ToolContext,
  signals: PhaseSignals,
): Promise<{ ok: true; childCount: number; readyCount: number }> {
  if (!isCampaignJob(ctx.job)) {
    throw new Error('campaign_finalize refused: this job is not a campaign.')
  }
  const job = (await ctx.stateBackend.getJob(ctx.job.id)) as Job
  const children = job.campaignChildren ?? []

  if (children.length === 0) {
    throw new Error(
      'campaign_finalize refused: no children registered. ' +
        'Use campaign_register_child to add at least one issue first.',
    )
  }

  // Validate every dependsOn target resolves to a registered child. Dangling
  // refs would otherwise cause the dispatcher to never pick the dependent
  // child, manifesting as a silent stall.
  const names = new Set(children.map(c => c.name))
  for (const c of children) {
    for (const dep of c.dependsOn) {
      if (!names.has(dep)) {
        throw new Error(
          `Child "${c.name}" depends on unknown child "${dep}". ` +
            `Either register "${dep}" first or remove the dependency.`,
        )
      }
    }
  }

  // Cycle detection via Kahn's algorithm. We mutate a working copy so the
  // result of finalize doesn't depend on iteration order.
  const cycle = detectCycle(children)
  if (cycle) {
    throw new Error(
      `Dependency cycle detected: ${cycle.join(' -> ')}. ` +
        `Resolve the cycle (drop or invert one of the dependsOn edges) and call campaign_finalize again.`,
    )
  }

  // Promote children whose dependencies are already satisfied so the
  // dispatcher's first sweep has something to pick. On the first finalize
  // this promotes the dep-less roots; on a **remediation round** (the
  // integrator/evaluator looped back to campaign-planning and the planner
  // registered fix children) it also promotes new children whose
  // `dependsOn` reference already-completed children from earlier rounds —
  // no further child-stop event will ever fire for those, so finalize is
  // the only chance to mark the fixes dispatchable.
  const promoted = reconcileReady(children)
  const readyCount = promoted.filter(c => c.status === 'ready').length

  if (readyCount === 0) {
    throw new Error(
      'campaign_finalize refused: no child is dispatchable. Either every ' +
        'pending child has unsatisfied dependencies (check the dependsOn ' +
        'graph) or no new children were registered this round — register ' +
        'at least one dispatchable child before finalizing.',
    )
  }

  await ctx.stateBackend.updateJob(ctx.job.id, { campaignChildren: promoted })
  ctx.job = (await ctx.stateBackend.getJob(ctx.job.id)) as Job

  await ctx.stateBackend.appendLog(
    ctx.job.id,
    `[campaign_finalize] Plan accepted: ${promoted.length} children, ` +
      `${readyCount} ready to dispatch. Advancing to coordinating.`,
  )

  // Hand off to the runner: advance to coordinating. The runner's
  // `agent: null` handling parks the campaign job at status
  // `awaiting-children` from there, and the dispatcher's coordinator
  // hook does the actual child spawning.
  signals.nextPhase = 'coordinating'

  return { ok: true, childCount: promoted.length, readyCount }
}

// ── campaign_status ──────────────────────────────────────────────────────────

export interface CampaignStatusSummary {
  campaignJobId: string
  totalChildren: number
  byStatus: Record<CampaignChildStatus, number>
  /** Children in dispatcher dispatch order (post-finalize, pre-completion). */
  children: Array<Pick<
    CampaignChild,
    'name' | 'description' | 'status' | 'dependsOn' | 'trackerRef' | 'jobId' | 'startedAt' | 'completedAt'
  >>
  /** True iff every child is in a terminal status. */
  allTerminal: boolean
}

export async function campaignStatus(ctx: ToolContext): Promise<CampaignStatusSummary> {
  if (!isCampaignJob(ctx.job)) {
    throw new Error('campaign_status refused: this job is not a campaign.')
  }
  const job = (await ctx.stateBackend.getJob(ctx.job.id)) as Job
  const children = job.campaignChildren ?? []

  const byStatus: Record<CampaignChildStatus, number> = {
    pending: 0,
    ready: 0,
    dispatched: 0,
    complete: 0,
    failed: 0,
    escalated: 0,
    skipped: 0,
    cancelled: 0,
  }
  for (const c of children) byStatus[c.status]++

  return {
    campaignJobId: job.id,
    totalChildren: children.length,
    byStatus,
    children: children.map(c => ({
      name: c.name,
      description: c.description,
      status: c.status,
      dependsOn: c.dependsOn,
      ...(c.trackerRef ? { trackerRef: c.trackerRef } : {}),
      ...(c.jobId ? { jobId: c.jobId } : {}),
      ...(c.startedAt ? { startedAt: c.startedAt } : {}),
      ...(c.completedAt ? { completedAt: c.completedAt } : {}),
    })),
    allTerminal:
      children.length > 0 && children.every(c => isTerminalChildStatus(c.status)),
  }
}

// ── Live-control: skip / rerun / cancel ──────────────────────────────────────
//
// These three share a pattern: load the campaign, look up the child by name,
// validate the requested transition, mutate the child, persist, log. The
// dispatcher coordinator picks up the changes on its next sweep (it is
// invoked explicitly here for skip/rerun so children waiting on the affected
// node are not stuck for an extra tick).

export interface CampaignChildOpArgs {
  name: string
  /** Free-form note (used in logs and, for skip, surfaced to dependent children). */
  reason?: string
}

export async function campaignSkipChild(
  args: CampaignChildOpArgs,
  ctx: ToolContext,
): Promise<{ ok: true; name: string; status: CampaignChildStatus }> {
  return mutateChild(ctx, args.name, current => {
    // Idempotent on already-skipped.
    if (current.status === 'skipped') return current
    // For terminal-but-not-skipped (failed / escalated / complete / cancelled),
    // we used to throw. That created a sharp edge: the dashboard's halt-
    // banner "Skip all" button is wired to this same code path and would
    // 500 on every halted child. Skip and Cancel/Abandon have identical
    // downstream semantics (both are `isSatisfiedChildStatus` ⇒ dependents
    // unblock), so treat skip-on-failed-or-escalated as an Abandon: convert
    // to `cancelled`. Complete is left alone — accepted work is immutable.
    if (current.status === 'complete') {
      throw new Error(
        `Cannot skip "${args.name}": already complete (work was accepted as done).`,
      )
    }
    if (current.status === 'cancelled') return current
    if (current.status === 'failed' || current.status === 'escalated') {
      return { ...current, status: 'cancelled' as const, completedAt: new Date().toISOString() }
    }
    return { ...current, status: 'skipped' as const, completedAt: new Date().toISOString() }
  }, `[campaign] Skipped child "${args.name}"${args.reason ? ` — ${args.reason}` : ''}`)
}

// ── campaignAbandonChild ─────────────────────────────────────────────────────
//
// "Abandon" is the user-facing verb merging Skip and Cancel for the dashboard.
// Both states (`skipped` and `cancelled`) satisfy dependents identically, so
// having two buttons added cognitive overhead without any behavioural payoff.
// Internally we route to the existing campaignCancelChild path so cascade
// semantics (cancelling the live child Job, if any) stay intact.
export async function campaignAbandonChild(
  args: CampaignChildOpArgs,
  ctx: ToolContext,
): Promise<{ ok: true; name: string; status: CampaignChildStatus }> {
  // Idempotent on already-cancelled — return current snapshot rather than
  // throwing so a double-click in the dashboard doesn't surface as an error.
  const job = (await ctx.stateBackend.getJob(ctx.job.id)) as Job | null
  const current = (job?.campaignChildren ?? []).find(c => c.name === args.name)
  if (current?.status === 'cancelled' || current?.status === 'skipped') {
    return { ok: true, name: args.name, status: current.status }
  }
  return campaignCancelChild(args, ctx)
}

// ── campaignResumeChild ──────────────────────────────────────────────────────
//
// Resume re-enters the EXISTING failed/escalated child Job at its last phase,
// preserving transcript and any PRs. This is the recovery action you almost
// always want — destructive "start fresh" (drop the Job, dispatch a new one)
// is reserved for `campaignRerunChild`.
//
// This tool only mutates the parent's campaignChildren record. The dispatcher
// wrapper (`Dispatcher.campaignResumeChild`) is responsible for actually
// flipping the child Job's status and firing the runner — that side requires
// dispatcher-level concurrency primitives the tool layer doesn't have.
export async function campaignResumeChild(
  args: CampaignChildOpArgs,
  ctx: ToolContext,
): Promise<{ ok: true; name: string; status: CampaignChildStatus; childJobId: string }> {
  const job = (await ctx.stateBackend.getJob(ctx.job.id)) as Job | null
  if (!job) {
    throw new Error(`Resume refused: campaign job ${ctx.job.id} not found.`)
  }
  if (!isCampaignJob(job)) {
    throw new Error('Resume refused: this job is not a campaign.')
  }
  const children = job.campaignChildren ?? []
  const current = children.find(c => c.name === args.name)
  if (!current) {
    throw new Error(`No child named "${args.name}" on this campaign.`)
  }
  if (current.status !== 'failed' && current.status !== 'escalated') {
    throw new Error(
      `Cannot resume "${args.name}": status is ${current.status}. ` +
        `Resume only applies to failed or escalated children. ` +
        `Use campaign_rerun_child for a fresh-job retry from a different terminal state.`,
    )
  }
  if (!current.jobId) {
    throw new Error(
      `Cannot resume "${args.name}": no underlying child Job id recorded. ` +
        `Use campaign_rerun_child to dispatch a new Job from the spec.`,
    )
  }

  const childJobId = current.jobId
  await mutateChild(ctx, args.name, c => {
    const next = { ...c, status: 'dispatched' as const }
    delete next.completedAt
    return next
  }, `[campaign] Resumed child "${args.name}"${args.reason ? ` — ${args.reason}` : ''}`)

  return { ok: true, name: args.name, status: 'dispatched', childJobId }
}

export async function campaignRerunChild(
  args: CampaignChildOpArgs,
  ctx: ToolContext,
): Promise<{ ok: true; name: string; status: CampaignChildStatus }> {
  return mutateChild(ctx, args.name, current => {
    // Rerun resets a terminal child to `pending` so the coordinator's
    // dependency check decides whether to flip to `ready`. Clearing
    // `jobId` ensures the dispatcher creates a fresh child Job on the
    // next sweep instead of re-using a completed one.
    if (!isTerminalChildStatus(current.status)) {
      throw new Error(
        `Cannot rerun "${args.name}": child is currently ${current.status}. ` +
          `Wait for it to reach a terminal state (or use campaign_cancel_child first).`,
      )
    }
    const next = { ...current, status: 'pending' as const }
    delete next.jobId
    delete next.completedAt
    delete next.startedAt
    return next
  }, `[campaign] Reset child "${args.name}" for rerun${args.reason ? ` — ${args.reason}` : ''}`)
}

export async function campaignCancelChild(
  args: CampaignChildOpArgs,
  ctx: ToolContext,
): Promise<{ ok: true; name: string; status: CampaignChildStatus }> {
  // Cascade-cancel the underlying child Job (if any) before mutating the
  // child record. Doing it first means an in-flight job can't keep emitting
  // status updates that would re-flip the child after we mark it cancelled.
  // We deliberately ignore failures here — if the cascade write fails the
  // mutateChild call below still escalates a clear error.
  const job = (await ctx.stateBackend.getJob(ctx.job.id)) as Job
  const child = (job.campaignChildren ?? []).find(c => c.name === args.name)
  if (child?.jobId) {
    const childJob = await ctx.stateBackend.getJob(child.jobId)
    if (childJob && !isStoppedStatus(childJob.status)) {
      await ctx.stateBackend.updateJob(child.jobId, cancelledJobPatch())
      await ctx.stateBackend.appendLog(
        child.jobId,
        `[cancelled] Cancelled by parent campaign ${ctx.job.id}` +
          (args.reason ? ` — ${args.reason}` : ''),
      )
    }
  }

  return mutateChild(ctx, args.name, current => {
    if (current.status === 'cancelled') {
      throw new Error(`Cannot cancel "${args.name}": already cancelled.`)
    }
    if (current.status === 'complete' || current.status === 'skipped') {
      throw new Error(
        `Cannot cancel "${args.name}": already ${current.status} (work was already accepted as done). ` +
          `Cancellation is for descoping work that has not been accepted.`,
      )
    }
    // failed / escalated / pending / ready / dispatched all transition to
    // cancelled. The cascade above handles in-flight Job termination; here
    // we just mutate the parent's child record.
    return { ...current, status: 'cancelled' as const, completedAt: new Date().toISOString() }
  }, `[campaign] Cancelled child "${args.name}"${args.reason ? ` — ${args.reason}` : ''}`)
}

// ── Internals ────────────────────────────────────────────────────────────────

async function mutateChild(
  ctx: ToolContext,
  name: string,
  apply: (current: CampaignChild) => CampaignChild,
  logLine: string,
): Promise<{ ok: true; name: string; status: CampaignChildStatus }> {
  // Load the live job first. We deliberately do NOT validate against
  // `ctx.job`: HTTP/CLI live-control paths build a stub ToolContext with
  // only `id` populated, so `isCampaignJob(ctx.job)` would spuriously
  // reject every mutation. Validate against the persisted job instead.
  const job = (await ctx.stateBackend.getJob(ctx.job.id)) as Job | null
  if (!job) {
    throw new Error(`Mutation refused: campaign job ${ctx.job.id} not found.`)
  }
  if (!isCampaignJob(job)) {
    throw new Error('Mutation refused: this job is not a campaign.')
  }
  const children = job.campaignChildren ?? []
  const idx = children.findIndex(c => c.name === name)
  if (idx === -1) {
    throw new Error(`No child named "${name}" on this campaign.`)
  }

  const updatedChild = apply(children[idx])
  const updated = [...children]
  updated[idx] = updatedChild

  // Promote any pending children whose deps are now all satisfied. Keeps
  // the in-memory view consistent with what the coordinator hook will see;
  // the actual Job spawn still goes through the dispatcher.
  const reconciled = reconcileReady(updated)

  await ctx.stateBackend.updateJob(ctx.job.id, { campaignChildren: reconciled })
  ctx.job = (await ctx.stateBackend.getJob(ctx.job.id)) as Job
  await ctx.stateBackend.appendLog(ctx.job.id, logLine)

  return { ok: true, name, status: updatedChild.status }
}

/**
 * Promote `pending` children to `ready` when every entry in their
 * `dependsOn` is satisfied (complete or skipped). Pure function — caller
 * persists the result. Used after every mutation so a downstream
 * dispatcher sweep doesn't need to re-walk the graph.
 */
export function reconcileReady(children: CampaignChild[]): CampaignChild[] {
  const byName = new Map(children.map(c => [c.name, c]))
  return children.map(c => {
    if (c.status !== 'pending') return c
    const ok = c.dependsOn.every(dep => {
      const target = byName.get(dep)
      return !!target && isSatisfiedChildStatus(target.status)
    })
    return ok ? { ...c, status: 'ready' as const } : c
  })
}

/**
 * Return one cycle's node sequence (closed by repeating the entry point) if a
 * cycle exists in the dependency graph; otherwise return `null`. Implementation
 * is iterative DFS with a recursion-stack set so we can rebuild the offending
 * cycle for a useful error message — agents will use the path to fix the plan.
 */
export function detectCycle(children: CampaignChild[]): string[] | null {
  const adj = new Map<string, string[]>()
  for (const c of children) adj.set(c.name, c.dependsOn)

  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const colour = new Map<string, number>()
  for (const name of adj.keys()) colour.set(name, WHITE)

  const stack: string[] = []

  function visit(node: string): string[] | null {
    colour.set(node, GRAY)
    stack.push(node)
    for (const next of adj.get(node) ?? []) {
      const c = colour.get(next) ?? WHITE
      if (c === GRAY) {
        // Cycle: rebuild the slice of stack from `next` onwards plus the
        // closing node so the caller can render a → b → c → a.
        const start = stack.indexOf(next)
        return start >= 0 ? [...stack.slice(start), next] : [next, node, next]
      }
      if (c === WHITE) {
        const found = visit(next)
        if (found) return found
      }
    }
    stack.pop()
    colour.set(node, BLACK)
    return null
  }

  for (const name of adj.keys()) {
    if (colour.get(name) === WHITE) {
      const cycle = visit(name)
      if (cycle) return cycle
    }
  }
  return null
}

/**
 * Map a stopped child Job's status to a `CampaignChildStatus` for the
 * coordinator hook. Lives here so the mapping is co-located with the
 * status type and stays in sync with status constants.
 */
export function jobStatusToChildStatus(jobStatus: string): CampaignChildStatus | null {
  if (jobStatus === STATUS_COMPLETE) return 'complete'
  if (jobStatus === STATUS_FAILED) return 'failed'
  if (jobStatus === STATUS_ESCALATED) return 'escalated'
  if (jobStatus === STATUS_CANCELLED) return 'cancelled'
  return null
}

/**
 * The status string used by the runner when parking a campaign job during
 * coordination. Re-exported so the dispatcher / runner only import from
 * this module to avoid drift.
 */
export const CAMPAIGN_PARKED_STATUS = STATUS_AWAITING_CHILDREN
