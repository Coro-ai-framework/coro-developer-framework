import type { Job } from '@coro-ai/cloud-protocol'

export interface ShadowDecisionSummary {
  recorded: number
  bySite: Record<string, { calls: number; flagged: number; actedOn: number; avgLatencyMs: number; inputTokens: number }>
  flagged: number
  actedOn: number
  avgLatencyMs: number
  inputTokens: number
}

/**
 * Join recorded decisions into the numbers a shadow trial needs: how often
 * each site fired, how often it would have acted, and what it cost in
 * latency and tokens. Agreement against later human action is left to the
 * operator — this only aggregates what the job already stored.
 */
export function summarizeDecisionRecords(jobs: readonly Job[]): ShadowDecisionSummary {
  const bySite: ShadowDecisionSummary['bySite'] = {}
  let flagged = 0
  let actedOn = 0
  let latencySum = 0
  let inputTokens = 0
  let recorded = 0

  for (const job of jobs) {
    for (const record of job.decisionRecords ?? []) {
      recorded += 1
      latencySum += record.latencyMs
      inputTokens += record.inputTokens
      if (record.flagReason) flagged += 1
      if (record.actedOn) actedOn += 1
      const row = bySite[record.site] ?? { calls: 0, flagged: 0, actedOn: 0, avgLatencyMs: 0, inputTokens: 0 }
      row.calls += 1
      if (record.flagReason) row.flagged += 1
      if (record.actedOn) row.actedOn += 1
      row.inputTokens += record.inputTokens
      row.avgLatencyMs += record.latencyMs
      bySite[record.site] = row
    }
  }

  for (const row of Object.values(bySite)) {
    row.avgLatencyMs = row.calls > 0 ? Math.round(row.avgLatencyMs / row.calls) : 0
  }

  return {
    recorded,
    bySite,
    flagged,
    actedOn,
    avgLatencyMs: recorded > 0 ? Math.round(latencySum / recorded) : 0,
    inputTokens,
  }
}
