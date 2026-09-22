import type { DecisionMode, DecisionRecord, Job } from '@coro-ai/cloud-protocol'
import type { Logger } from 'pino'
import type { ResolvedDecisionConfig } from '../config/local-config'
import { recordDecision } from '../clients/decision/record'
import type { DecisionProvider } from '../clients/decision/types'
import type { StateBackend } from '../state/backend'
import type { PhaseConfig } from '../workflow-parser'
import { buildOverseerQuestions, DEFAULT_PHASE_OBLIGATIONS, NONE_OPTION } from './questions'
import { buildTrajectoryState, renderStateDigest } from './state'

export interface OverseerOutcome {
  called: boolean
  flag: boolean
  reason?: string
  record?: DecisionRecord
}

export function shouldParkForOverseer(args: {
  outcome: OverseerOutcome
  interactive: boolean
  onFlag: 'park' | 'flag-only'
  mode: DecisionMode
  approvedAdvanceFromPhase?: string
  phase: string
}): boolean {
  if (!args.outcome.flag) return false
  if (args.mode !== 'live') return false
  if (args.onFlag !== 'park') return false
  if (!args.interactive) return false
  if (args.approvedAdvanceFromPhase === args.phase) return false
  return true
}

function effectiveMode(
  config: ResolvedDecisionConfig,
  site: string,
): DecisionMode {
  return config.sites[site] ?? config.mode
}

function isCampaignScoped(job: Job): boolean {
  return Boolean(job.campaignParentId) || Array.isArray(job.campaignChildren)
}

function obligationText(obligations: readonly string[], choice: string): string {
  const match = /^obligation\[(\d+)\]$/.exec(choice)
  if (!match) return choice
  const index = Number(match[1])
  return obligations[index] ?? choice
}

export function evaluateOverseerFlag(
  answers: Record<string, { type: string; noul?: number; choice?: string; confidence?: number; score?: number }>,
  thresholds: ResolvedDecisionConfig['overseer']['thresholds'],
  obligations: readonly string[],
): { flag: boolean; reason?: string } {
  const offTrack = answers['off_track']
  const breach = answers['breach']
  const severity = answers['severity']

  const driftFlag = offTrack?.type === 'noul'
    && typeof offTrack.noul === 'number'
    && offTrack.noul <= (1 - thresholds.offTrackNoul)

  const breachFlag = breach?.type === 'choice'
    && typeof breach.choice === 'string'
    && breach.choice !== NONE_OPTION
    && typeof breach.confidence === 'number'
    && breach.confidence >= thresholds.minChoiceConfidence
    && severity?.type === 'score'
    && typeof severity.score === 'number'
    && severity.score >= thresholds.severityScore

  if (driftFlag) {
    const noul = offTrack?.noul ?? 0
    return {
      flag: true,
      reason:
        `Overseer flagged: the work no longer looks aligned with the stated objective `
        + `(on-track probability ${noul.toFixed(2)}).`,
    }
  }
  if (breachFlag && breach?.choice) {
    return {
      flag: true,
      reason:
        `Overseer flagged: obligation "${obligationText(obligations, breach.choice)}" looks unmet `
        + `(confidence ${(breach.confidence ?? 0).toFixed(2)}, severity ${(severity?.score ?? 0).toFixed(1)} of 3).`,
    }
  }
  return { flag: false }
}

export async function runOverseer(args: {
  job: Job
  phaseConf: PhaseConfig | null | undefined
  checkpointPhases: ReadonlySet<string>
  decision: DecisionProvider
  config: ResolvedDecisionConfig
  stateBackend: StateBackend
  logger: Logger
}): Promise<OverseerOutcome> {
  try {
    const mode = effectiveMode(args.config, 'overseer')
    if (mode === 'off') return { called: false, flag: false }

    if (args.config.overseer.scope === 'off') return { called: false, flag: false }
    if (args.config.overseer.scope === 'campaigns' && !isCampaignScoped(args.job)) {
      return { called: false, flag: false }
    }

    const obligations = args.phaseConf?.obligations?.length
      ? args.phaseConf.obligations
      : DEFAULT_PHASE_OBLIGATIONS
    const trajectory = buildTrajectoryState(args.job, args.checkpointPhases)
    const stateDigest = renderStateDigest(trajectory)
    const result = await args.decision.ask({
      state: {
        phase_obligations: [...obligations],
        trajectory,
      },
      questions: buildOverseerQuestions(obligations),
    })

    if (!result.available) {
      args.logger.debug(
        { jobId: args.job.id, phase: args.job.phase, reason: result.reason },
        'Overseer skipped — decision provider unavailable',
      )
      return { called: false, flag: false }
    }

    const judged = evaluateOverseerFlag(result.answers, args.config.overseer.thresholds, obligations)
    const live = mode === 'live'
    const record = await recordDecision({
      stateBackend: args.stateBackend,
      jobId: args.job.id,
      site: 'overseer',
      phase: args.job.phase,
      mode,
      result,
      stateDigest,
      actedOn: live && judged.flag,
      flagReason: judged.reason,
    })
    return {
      called: true,
      flag: judged.flag,
      ...(judged.reason ? { reason: judged.reason } : {}),
      record,
    }
  } catch (err) {
    args.logger.warn(
      { err, jobId: args.job.id, phase: args.job.phase },
      'Overseer failed — continuing as if the layer were off',
    )
    return { called: false, flag: false }
  }
}

export { DEFAULT_PHASE_OBLIGATIONS, NONE_OPTION } from './questions'
export { buildTrajectoryState, renderStateDigest } from './state'
