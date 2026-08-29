// ── Job completion gate ──────────────────────────────────────────────────────
//
// Workflow-agnostic invariant: a job is allowed to transition to
// `STATUS_COMPLETE` only when every registered work item is either
// `complete` or `escalated`. Jobs with no work items (campaigns, jobs
// whose planner never called `set_work_items`, fast-lane single-scope
// jobs) bypass the gate — they have no contract for the runner to enforce.
//
// When the gate blocks, the runner injects a structured `pendingPrompt`
// that names the unfinished work items and the still-open PR mappings,
// then re-runs the **current** phase so the same agent can self-correct
// via `goto_phase`, `update_work_item`, merges, etc. This intentionally
// avoids hardcoding any specific phase transition — workflows differ
// (standard `coding/review/evaluation`, fast `review-and-verify`, deep
// extra QA), so the agent's own intelligence chooses where to route.
//
// A retry cap converts a stuck loop (model ends turn without acting)
// into an explicit failure rather than burning tokens forever.

import type { Job, PrMapping, WorkItem } from '@coro-ai/cloud-protocol'

/** Maximum consecutive completion-gate blocks before failing the job. */
export const COMPLETION_GATE_MAX_RETRIES = 5

export interface CompletionGateDecision {
  /** True when the runner may transition the job to `STATUS_COMPLETE`. */
  ready: boolean
  /** Work items still blocking completion (empty when `ready`). */
  blockingWorkItems: WorkItem[]
}

export function jobHasWorkItems(job: Job): boolean {
  return Array.isArray(job.workItems) && job.workItems.length > 0
}

export function evaluateCompletionGate(job: Job): CompletionGateDecision {
  if (!jobHasWorkItems(job)) {
    return { ready: true, blockingWorkItems: [] }
  }
  const blocking = job.workItems.filter(
    w => w.status !== 'complete' && w.status !== 'escalated',
  )
  return { ready: blocking.length === 0, blockingWorkItems: blocking }
}

interface PrSummary {
  workItem: string
  open: PrMapping[]
  merged: PrMapping[]
}

function summarizePrMappings(mappings: PrMapping[]): PrSummary[] {
  const groups = new Map<string, PrSummary>()
  for (const mapping of mappings) {
    const key = mapping.workItem || '(unattributed)'
    let group = groups.get(key)
    if (!group) {
      group = { workItem: key, open: [], merged: [] }
      groups.set(key, group)
    }
    if (mapping.mergedAt) group.merged.push(mapping)
    else group.open.push(mapping)
  }
  return Array.from(groups.values())
}

export function buildJobCompletionBlockPrompt(
  job: Job,
  decision: CompletionGateDecision,
  attempt: number,
): string {
  const lines: string[] = []
  lines.push('[completion-gate] Job cannot complete yet.')
  lines.push('')
  lines.push(
    `There ${decision.blockingWorkItems.length === 1 ? 'is' : 'are'} ` +
      `${decision.blockingWorkItems.length} unfinished work item(s) on this job. ` +
      `The runner will not advance to STATUS_COMPLETE until every work item is ` +
      `marked \`complete\` (or \`escalated\`).`,
  )
  lines.push('')
  lines.push('Unfinished work items:')
  for (const wi of decision.blockingWorkItems) {
    lines.push(`  - ${wi.name} — status: ${wi.status}, loopCount: ${wi.loopCount}`)
  }

  if (Array.isArray(job.prMappings) && job.prMappings.length > 0) {
    lines.push('')
    lines.push('PR mappings on this job:')
    for (const group of summarizePrMappings(job.prMappings)) {
      const openIds = group.open.map(p => `#${p.prId}`).join(', ') || 'none'
      const mergedIds = group.merged.map(p => `#${p.prId}`).join(', ') || 'none'
      lines.push(
        `  - ${group.workItem}: open=${group.open.length} [${openIds}] ` +
          `merged=${group.merged.length} [${mergedIds}]`,
      )
    }
  }

  lines.push('')
  lines.push('What to do next:')
  lines.push(
    '  1. Confirm the current state of all work items and PR mappings.',
  )
  lines.push(
    '  2. Drive each unfinished work item to `complete` per your workflow ' +
      'intelligence — typically: finish coding the work item, get its PR(s) ' +
      'reviewed and merged, then mark the work item as `complete`.',
  )
  lines.push(
    '  3. Use `goto_phase` to re-enter the phase that owns the remaining work ' +
      '(e.g. `coding` if implementation is incomplete, or the review/gatekeeper ' +
      'phase for your workflow if PRs are open and awaiting merge). Do NOT end ' +
      'your turn expecting the job to finish while work items are still pending ' +
      'or in-progress.',
  )
  lines.push(
    `  4. If you genuinely cannot make progress, call \`escalate\` with a clear ` +
      `reason; an escalated work item also satisfies this gate.`,
  )
  lines.push('')
  lines.push(
    `(attempt ${attempt}/${COMPLETION_GATE_MAX_RETRIES} — after the cap the ` +
      `runner will fail the job to avoid an infinite loop.)`,
  )

  return lines.join('\n')
}

export function buildJobCompletionFailureMessage(
  decision: CompletionGateDecision,
): string {
  const names = decision.blockingWorkItems.map(w => w.name).join(', ')
  return (
    `Job failed: completion gate blocked ${COMPLETION_GATE_MAX_RETRIES} consecutive ` +
    `attempts. Work items still incomplete: ${names || '(unknown)'}. ` +
    `Resolve via dashboard or new job.`
  )
}

// ── Phase-advance PR-merge gate ──────────────────────────────────────────────
//
// Workflow-agnostic invariant, mirrored from `evaluateCompletionGate` above:
// the runner must not silently advance away from a phase while the *current*
// work item still has an open (unmerged) PR mapping. Unlike the completion
// gate (which only fires at the end of the workflow), this fires on every
// non-terminal advance — in practice that is only ever the review boundary,
// because `prMappings` for the current work item is empty until the review
// phase opens a PR. Only the *implicit* default advance is gated (see
// `runner.ts`); an explicit `goto_phase` call is treated as an intentional
// waiver, same as the rest of this file treats agent intelligence as the
// source of truth over hardcoded phase names.

/** Maximum consecutive phase-advance-gate blocks before failing the job. */
export const PHASE_ADVANCE_GATE_MAX_RETRIES = 5

export interface PhaseAdvanceGateDecision {
  /** True when the runner may advance away from the current phase. */
  ready: boolean
  /** Open (unmerged) PR mappings for the current work item, if any. */
  openMappings: PrMapping[]
}

export function evaluatePhaseAdvanceGate(job: Job): PhaseAdvanceGateDecision {
  const workItem = job.currentWorkItem
  if (!workItem || !Array.isArray(job.prMappings) || job.prMappings.length === 0) {
    return { ready: true, openMappings: [] }
  }
  const openMappings = job.prMappings.filter(m => m.workItem === workItem && !m.mergedAt)
  return { ready: openMappings.length === 0, openMappings }
}

export function buildPhaseAdvanceBlockPrompt(
  job: Job,
  decision: PhaseAdvanceGateDecision,
  nextPhase: string,
  attempt: number,
): string {
  const lines: string[] = []
  lines.push('[phase-advance-gate] Cannot leave this phase yet.')
  lines.push('')
  lines.push(
    `The current work item ("${job.currentWorkItem}") still has ` +
      `${decision.openMappings.length} open (unmerged) PR mapping(s). The runner will ` +
      `not auto-advance to \`${nextPhase}\` while any of them is open.`,
  )
  lines.push('')
  lines.push('Open PR mappings:')
  for (const m of decision.openMappings) {
    lines.push(`  - #${m.prId}`)
  }
  lines.push('')
  lines.push('What to do next:')
  lines.push('  1. Confirm live PR state with `scm_get_pr_status`.')
  lines.push(
    '  2. If human approval is still pending, call `await_event` with ' +
      '`eventName: "pr:approved"` and the PR id — do NOT end your turn expecting ' +
      'the runner to advance for you.',
  )
  lines.push('  3. Once approved, call `scm_merge_pr` to merge before ending your turn.')
  lines.push(
    `  4. If leaving now is intentional, call \`goto_phase("${nextPhase}")\` explicitly — ` +
      `an explicit call is treated as a waiver of this gate.`,
  )
  lines.push('')
  lines.push(
    `(attempt ${attempt}/${PHASE_ADVANCE_GATE_MAX_RETRIES} — after the cap the ` +
      `runner will fail the job to avoid an infinite loop.)`,
  )

  return lines.join('\n')
}

export function buildPhaseAdvanceFailureMessage(
  decision: PhaseAdvanceGateDecision,
): string {
  const ids = decision.openMappings.map(m => `#${m.prId}`).join(', ')
  return (
    `Job failed: phase-advance gate blocked ${PHASE_ADVANCE_GATE_MAX_RETRIES} consecutive ` +
    `attempts to leave this phase with an open PR mapping (${ids || '(unknown)'}). ` +
    `Resolve via dashboard or new job.`
  )
}
