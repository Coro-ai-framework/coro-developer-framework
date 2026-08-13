// ── Per-phase kickoff prompt helpers ─────────────────────────────────────────
//
// Short nudges the runner injects at the start of each phase (unless
// pendingPrompt from webhooks / developer input takes precedence).
// Includes multi-PR awareness for jobs with several open mappings.

import type { Job, PrMapping } from '@coro-ai/cloud-protocol'
import {
  buildWorkspaceLayoutKickoffBlock,
  resolveJobWorkspaceLayout,
} from './workspace-layout'

export function formatRelativeAge(isoTimestamp: string, nowMs = Date.now()): string {
  const then = Date.parse(isoTimestamp)
  if (!Number.isFinite(then)) return 'unknown'
  const diffMs = Math.max(0, nowMs - then)
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function openPrMappings(job: Job): PrMapping[] {
  return job.prMappings.filter(pm => !pm.mergedAt)
}

function recentlyMerged(job: Job, limit = 5): PrMapping[] {
  return job.prMappings
    .filter(pm => pm.mergedAt)
    .sort((a, b) => Date.parse(b.mergedAt!) - Date.parse(a.mergedAt!))
    .slice(0, limit)
}

export function buildOpenPrsKickoffBlock(job: Job, nowMs = Date.now()): string {
  const open = openPrMappings(job)
  const merged = recentlyMerged(job)
  if (open.length === 0 && merged.length === 0) return ''

  const lines: string[] = ['', '## Open PRs on this job', '']

  if (open.length > 0) {
    lines.push('| PR | Work item | Age | Notes |')
    lines.push('|----|-----------|-----|-------|')
    for (const pm of open) {
      const wi = pm.workItem || '(unattributed)'
      lines.push(`| #${pm.prId} | ${wi} | ${formatRelativeAge(pm.openedAt, nowMs)} | open |`)
    }
  } else {
    lines.push('No open PRs — all registered mappings are merged.')
  }

  if (merged.length > 0) {
    lines.push('')
    lines.push('Recently merged:')
    for (const pm of merged) {
      const wi = pm.workItem || '(unattributed)'
      lines.push(
        `- PR #${pm.prId} (${wi}) merged ${formatRelativeAge(pm.mergedAt!, nowMs)}`,
      )
    }
  }

  return lines.join('\n')
}

export function resolveNextDeclaredPhase(
  currentPhase: string,
  declaredPhases: string[],
): string | null {
  const idx = declaredPhases.indexOf(currentPhase)
  if (idx === -1 || idx === declaredPhases.length - 1) return null
  return declaredPhases[idx + 1] ?? null
}

export function buildCodingPreflightWarning(
  job: Job,
  declaredPhases?: string[],
): string {
  if (job.phase !== 'coding' || !job.currentWorkItem) return ''

  const openForWi = openPrMappings(job).filter(
    pm => pm.workItem === job.currentWorkItem,
  )
  if (openForWi.length === 0) return ''

  const prList = openForWi.map(pm => `#${pm.prId}`).join(', ')
  const reviewPhase = declaredPhases?.length
    ? resolveNextDeclaredPhase('coding', declaredPhases)
    : null
  const handoffHint = reviewPhase
    ? `end your turn to advance to \`${reviewPhase}\` (the review/gatekeeper phase for this workflow)`
    : 'end your turn to advance to the review/gatekeeper phase for this workflow'

  return [
    '[coding-preflight] Heads up: work item "' + job.currentWorkItem + '" already has ' +
      `${openForWi.length} open PR(s): ${prList}.`,
    `Unless you are responding to review feedback on these exact PRs, ${handoffHint} ` +
      'so the merge gatekeeper can drive this work item to completion.',
    'Opening new PRs while these are unmerged compounds the review backlog.',
    '',
  ].join('\n')
}

/**
 * The developer's words from the checkpoint that let this phase start.
 *
 * Empty unless the approval was addressed to this exact phase: the phase
 * that was approved already read the reply in its own resume prompt, and an
 * approval left over from a transition that did not happen must not read as
 * guidance somewhere else. When it does apply it leads the kickoff, because
 * for a phase whose job is to act on a decision, the decision is the first
 * thing to read.
 */
export function buildCheckpointApprovalBlock(job: Job): string {
  const approval = job.checkpointApproval
  if (!approval?.message?.trim()) return ''
  if (approval.forPhase !== job.phase) return ''

  return [
    `[DEVELOPER APPROVAL] The developer approved leaving phase \`${approval.fromPhase}\`, which is why`,
    `you are in \`${job.phase}\` now. They said:`,
    '',
    `"${approval.message.trim()}"`,
    '',
    'Treat this as your instruction set, not as encouragement: act on what it approves and ' +
    'leave out what it does not. If it asks for something this phase cannot do, say so with ' +
    '`escalate` rather than doing an approximation of it.',
    '',
  ].join('\n')
}

export function buildPhaseKickoffMessage(
  job: Job,
  jobWorkingDir: string,
  nowMs = Date.now(),
  declaredPhases?: string[],
): string {
  const approval = buildCheckpointApprovalBlock(job)
  const preflight = buildCodingPreflightWarning(job, declaredPhases)
  const workspace = buildWorkspaceLayoutKickoffBlock(
    resolveJobWorkspaceLayout(job, jobWorkingDir),
  )
  const base = job.sessionId
    ? (
      `You are now in phase **${job.phase}**. Your role for this phase is in the ` +
      `system prompt under "Your Role This Phase". Continue the job — do what the phase ` +
      `instructs, then let your turn end (the runner auto-advances).`
    )
    : (
      `Begin phase **${job.phase}** of this ${job.type} job. Your role and the full ` +
      `workflow are in the system prompt. Follow your phase instructions and use the ` +
      `\`log\` tool to report progress.`
    )

  const openPrs = buildOpenPrsKickoffBlock(job, nowMs)
  return [approval, preflight, workspace, base, openPrs].filter(Boolean).join('\n')
}
