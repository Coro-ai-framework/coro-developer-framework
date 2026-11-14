import type { Job, PhaseUsage } from '@coro-ai/cloud-protocol'
import type { AttemptOutcome, Timeline } from './types'
import { reviewWaitMs } from './watch'
import { round, sum } from './util'

/**
 * Process metrics, computed from the raw job record the runner kept.
 *
 * The raw `job.json` is always saved next to the results, so a metric added
 * later can be computed for runs that happened before it existed. Everything
 * here reads fields defensively: a job record from an older or newer runner
 * may lack any of them.
 */

export interface PhaseMetrics {
  phase: string
  /** Times the phase ran, for any reason. */
  runs: number
  costUsd: number
  durationMs: number
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  models: string[]
  /** Runs the runner marked as a loop back (`attribution: 'rework'`). */
  reworkRuns: number
  reworkCostUsd: number
}

export interface Metrics {
  /** Final `Job.status`, or `unknown` if no job record was read. */
  jobStatus: string
  outcome: AttemptOutcome
  /** The job escalated: status `escalated`, or an escalation message was recorded. */
  escalated: boolean

  /** Dispatch to the end of the watch loop. */
  wallMs: number
  /** Sum of phase durations: time the agent was actually working. */
  agentMs: number
  /** Time parked on a pull request, including the reviewer's delay and the runner's poll. */
  reviewWaitMs: number

  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number

  /** Phase executions, and how many were loops rather than required passes. */
  phaseRuns: number
  reworkRuns: number
  reworkCostUsd: number
  /** Highest loop count on any work item: the evaluator's rework signal. */
  maxLoopCount: number
  workItemCount: number
  prCount: number
  toolCalls: number
  toolFailures: number
  /** Failed calls by tool, most failures first. */
  failedTools: Array<{ toolName: string; failures: number }>
  rateLimitRetries: number
  /** Phase runs whose `attribution` the runner recorded; the rest cannot be classified. */
  attributedRuns: number

  phases: PhaseMetrics[]
}

type PhaseUsageLike = Partial<PhaseUsage> & { phase: string }

function aggregatePhases(usages: readonly PhaseUsageLike[]): PhaseMetrics[] {
  const byPhase = new Map<string, PhaseMetrics>()
  for (const usage of usages) {
    const row =
      byPhase.get(usage.phase) ??
      ({
        phase: usage.phase,
        runs: 0,
        costUsd: 0,
        durationMs: 0,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        models: [],
        reworkRuns: 0,
        reworkCostUsd: 0,
      } satisfies PhaseMetrics)
    row.runs += 1
    row.costUsd += usage.costUsd ?? 0
    row.durationMs += usage.durationMs ?? 0
    row.turns += usage.numTurns ?? 0
    row.inputTokens += usage.inputTokens ?? 0
    row.outputTokens += usage.outputTokens ?? 0
    row.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0
    row.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0
    if (usage.model && !row.models.includes(usage.model)) row.models.push(usage.model)
    if (usage.attribution === 'rework') {
      row.reworkRuns += 1
      row.reworkCostUsd += usage.costUsd ?? 0
    }
    byPhase.set(usage.phase, row)
  }
  return [...byPhase.values()].map(row => ({ ...row, costUsd: round(row.costUsd), reworkCostUsd: round(row.reworkCostUsd) }))
}

export interface ComputeMetricsInput {
  job?: Job
  timeline: Timeline
  outcome: AttemptOutcome
}

export function computeMetrics({ job, timeline, outcome }: ComputeMetricsInput): Metrics {
  const usages: PhaseUsageLike[] = job?.phaseUsage ?? []
  const phases = aggregatePhases(usages)

  const phaseCost = sum(usages.map(u => u.costUsd ?? 0))
  const costUsd = round(job?.tokenUsage?.totalCostUsd || phaseCost)

  const tokenField = (
    key: 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens',
  ): number => job?.tokenUsage?.[key] ?? sum(usages.map(u => u[key] ?? 0))

  const ledger = usages.flatMap(u => u.toolLedger ?? [])
  const failures = new Map<string, number>()
  for (const call of ledger) {
    if (!call.success) failures.set(call.toolName, (failures.get(call.toolName) ?? 0) + 1)
  }

  const wallMs = Math.max(0, Date.parse(timeline.endedAt) - Date.parse(timeline.dispatchedAt)) || 0

  return {
    jobStatus: job?.status ?? 'unknown',
    outcome,
    escalated: job ? job.status === 'escalated' || Boolean(job.escalationMessage) : false,

    wallMs,
    agentMs: sum(usages.map(u => u.durationMs ?? 0)),
    reviewWaitMs: reviewWaitMs(timeline),

    costUsd,
    inputTokens: tokenField('inputTokens'),
    outputTokens: tokenField('outputTokens'),
    cacheReadInputTokens: tokenField('cacheReadInputTokens'),
    cacheCreationInputTokens: tokenField('cacheCreationInputTokens'),

    phaseRuns: usages.length,
    reworkRuns: sum(phases.map(p => p.reworkRuns)),
    reworkCostUsd: round(sum(phases.map(p => p.reworkCostUsd))),
    maxLoopCount: Math.max(0, ...(job?.workItems ?? []).map(item => item.loopCount ?? 0)),
    workItemCount: job?.workItems?.length ?? 0,
    prCount: job?.prMappings?.length ?? 0,
    toolCalls: ledger.length,
    toolFailures: sum([...failures.values()]),
    failedTools: [...failures.entries()]
      .map(([toolName, count]) => ({ toolName, failures: count }))
      .sort((a, b) => b.failures - a.failures || a.toolName.localeCompare(b.toolName)),
    rateLimitRetries: job?.rateLimitInfo?.retryAttempt ?? 0,
    attributedRuns: usages.filter(u => u.attribution !== undefined).length,

    phases,
  }
}
