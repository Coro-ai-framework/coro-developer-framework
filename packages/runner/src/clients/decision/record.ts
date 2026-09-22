import type { DecisionMode, DecisionRecord } from '@coro-ai/cloud-protocol'
import type { StateBackend } from '../../state/backend'
import type { DecisionSuccess } from './types'

export const DECISION_RECORD_CAP = 200

export async function recordDecision(args: {
  stateBackend: StateBackend
  jobId: string
  site: string
  phase: string
  mode: DecisionMode
  result: DecisionSuccess
  stateDigest?: string
  actedOn?: boolean
  flagReason?: string
}): Promise<DecisionRecord> {
  const now = new Date()
  const rand = Math.random().toString(36).slice(2, 8)
  const record: DecisionRecord = {
    id: `dec-${now.getTime()}-${rand}`,
    site: args.site,
    at: now.toISOString(),
    phase: args.phase,
    mode: args.mode,
    model: args.result.model,
    latencyMs: args.result.latencyMs,
    inputTokens: args.result.inputTokens,
    answers: args.result.answers,
    ...(args.stateDigest ? { stateDigest: args.stateDigest } : {}),
    ...(args.actedOn ? { actedOn: true } : {}),
    ...(args.flagReason ? { flagReason: args.flagReason } : {}),
  }

  const job = await args.stateBackend.getJob(args.jobId)
  const existing = job?.decisionRecords ?? []
  const next = [...existing, record]
  const decisionRecords = next.length > DECISION_RECORD_CAP
    ? next.slice(next.length - DECISION_RECORD_CAP)
    : next
  await args.stateBackend.updateJob(args.jobId, { decisionRecords })

  const summary = args.flagReason
    ? args.flagReason
    : Object.keys(args.result.answers).join(', ') || 'answered'
  await args.stateBackend.appendLog(
    args.jobId,
    `[decision] ${args.site} (${args.mode}) — ${summary}`,
  )
  return record
}
