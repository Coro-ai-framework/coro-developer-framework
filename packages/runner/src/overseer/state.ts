import type { Job } from '@coro-ai/cloud-protocol'
import { derivePhaseAttributions } from '../jobs/phase-observability'

export interface TrajectoryState {
  objective: string
  phase: string
  lane?: string
  workItems: Array<{ name: string; status: string; loopCount: number }>
  phaseRuns: Array<{ phase: string; runs: number; reworkRuns: number; costUsd: number; turns: number }>
  failedToolClasses: Array<{ toolName: string; errorClass: string; count: number }>
  laneSwitches: Array<{ from: string; to: string; reason: string }>
  openPrTitles: string[]
  totals: { costUsd: number; phaseRuns: number }
}

const OBJECTIVE_MAX_CHARS = 2_000
const FAILED_TOOL_CAP = 10
const LANE_SWITCH_CAP = 5

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

function objectiveOf(job: Job): string {
  const campaign = job.params['campaignDescription']
  if (typeof campaign === 'string' && campaign.trim()) return truncate(campaign.trim(), OBJECTIVE_MAX_CHARS)
  const description = job.params['description']
  if (typeof description === 'string' && description.trim()) return truncate(description.trim(), OBJECTIVE_MAX_CHARS)
  return ''
}

export function buildTrajectoryState(
  job: Job,
  checkpointPhases: ReadonlySet<string>,
): TrajectoryState {
  const usage = job.phaseUsage ?? []
  const attributions = derivePhaseAttributions(usage, {
    checkpointPhases,
    interactive: job.interactive,
  })

  const byPhase = new Map<string, { runs: number; reworkRuns: number; costUsd: number; turns: number }>()
  for (let i = 0; i < usage.length; i++) {
    const snap = usage[i]
    if (!snap) continue
    const current = byPhase.get(snap.phase) ?? { runs: 0, reworkRuns: 0, costUsd: 0, turns: 0 }
    current.runs += 1
    if (attributions[i] === 'rework') current.reworkRuns += 1
    current.costUsd += snap.costUsd ?? 0
    current.turns += snap.numTurns ?? 0
    byPhase.set(snap.phase, current)
  }

  const failedCounts = new Map<string, { toolName: string; errorClass: string; count: number }>()
  for (const snap of usage) {
    for (const entry of snap.toolLedger ?? []) {
      if (entry.success) continue
      const errorClass = entry.errorClass ?? 'error'
      const key = `${entry.toolName}|${errorClass}`
      const current = failedCounts.get(key) ?? { toolName: entry.toolName, errorClass, count: 0 }
      current.count += 1
      failedCounts.set(key, current)
    }
  }

  const lane = typeof job.params['lane'] === 'string' ? job.params['lane'] : undefined
  const switches = (job.workflowPathHistory ?? []).slice(-LANE_SWITCH_CAP).map(entry => ({
    from: entry.from,
    to: entry.to,
    reason: entry.reason,
  }))

  const phaseRuns = Array.from(byPhase.entries()).map(([phase, stats]) => ({
    phase,
    ...stats,
  }))
  const totals = {
    costUsd: phaseRuns.reduce((sum, row) => sum + row.costUsd, 0),
    phaseRuns: usage.length,
  }

  return {
    objective: objectiveOf(job),
    phase: job.phase,
    ...(lane ? { lane } : {}),
    workItems: (job.workItems ?? []).map(item => ({
      name: item.name,
      status: item.status,
      loopCount: item.loopCount ?? 0,
    })),
    phaseRuns,
    failedToolClasses: Array.from(failedCounts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, FAILED_TOOL_CAP),
    laneSwitches: switches,
    openPrTitles: (job.prMappings ?? [])
      .filter(mapping => !mapping.mergedAt)
      .map(mapping => mapping.workItem || `#${mapping.prId}`),
    totals,
  }
}

export function renderStateDigest(state: TrajectoryState): string {
  const lines: string[] = []
  lines.push(`Phase: ${state.phase}${state.lane ? ` · lane ${state.lane}` : ''}`)
  if (state.objective) {
    lines.push('Objective:')
    lines.push(state.objective)
  }
  if (state.workItems.length > 0) {
    lines.push('Work items:')
    for (const item of state.workItems) {
      lines.push(`  - ${item.name} (${item.status}, loopCount ${item.loopCount})`)
    }
  }
  if (state.phaseRuns.length > 0) {
    lines.push('Phase runs (computed):')
    for (const row of state.phaseRuns) {
      lines.push(
        `  - ${row.phase}: ${row.runs} run(s), ${row.reworkRuns} rework, `
        + `${row.turns} turns, $${row.costUsd.toFixed(4)}`,
      )
    }
  }
  lines.push(`Totals: ${state.totals.phaseRuns} phase run(s), $${state.totals.costUsd.toFixed(4)}`)
  if (state.failedToolClasses.length > 0) {
    lines.push('Failed tools:')
    for (const row of state.failedToolClasses) {
      lines.push(`  - ${row.toolName} [${row.errorClass}] ×${row.count}`)
    }
  }
  if (state.laneSwitches.length > 0) {
    lines.push('Lane switches:')
    for (const row of state.laneSwitches) {
      lines.push(`  - ${row.from} → ${row.to}: ${row.reason}`)
    }
  }
  if (state.openPrTitles.length > 0) {
    lines.push(`Open PRs: ${state.openPrTitles.join(', ')}`)
  }
  return lines.join('\n')
}
