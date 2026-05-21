// ── Per-phase kickoff prompt helpers ─────────────────────────────────────────
//
// Short nudges the runner injects at the start of each phase (unless
// pendingPrompt from webhooks / developer input takes precedence).
// Includes multi-PR awareness for jobs with several open mappings.

import type { Job, PrMapping } from '@coro/cloud-protocol'
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

export function buildCodingPreflightWarning(job: Job): string {
  if (job.phase !== 'coding' || !job.currentWorkItem) return ''

  const openForWi = openPrMappings(job).filter(
    pm => pm.workItem === job.currentWorkItem,
  )
  if (openForWi.length === 0) return ''

  const prList = openForWi.map(pm => `#${pm.prId}`).join(', ')
  return [
    '[coding-preflight] Heads up: work item "' + job.currentWorkItem + '" already has ' +
      `${openForWi.length} open PR(s): ${prList}.`,
    'Unless you are responding to review feedback on these exact PRs, hand off to review via ' +
      '`goto_phase("review")` so the merge gatekeeper can drive this work item to completion.',
    'Opening new PRs while these are unmerged compounds the review backlog.',
    '',
  ].join('\n')
}

export function buildPhaseKickoffMessage(
  job: Job,
  jobWorkingDir: string,
  nowMs = Date.now(),
): string {
  const preflight = buildCodingPreflightWarning(job)
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
  return [preflight, workspace, base, openPrs].filter(Boolean).join('\n')
}
