import type { Job } from '@coro-ai/cloud-protocol'
import type { Logger } from 'pino'
import type { DecisionProvider } from '../clients/decision/types'
import type { DecisionSettings, Settings } from '../config/settings'
import type { StateBackend } from '../state/backend'
import type { PhaseConfig } from '../workflow-parser'
import { runOverseer, shouldParkForOverseer } from '../overseer'
import { maybeAskInputScreen, maybeAskLane, maybeAskReviewLens, maybeAskWakeGate } from './sites'

export interface PhaseBoundaryAdvice {
  /** True when the overseer actually ran. The caller refreshes the job so the new record is visible. */
  consulted: boolean
  park: boolean
  flagReason?: string
}

export interface InboundEventView {
  eventKey: string
  payload: Record<string, unknown>
}

export interface InboundScreen {
  /** False when every event was judged not worth waking. The job stays parked. */
  resume: boolean
  warnings: string[]
}

/**
 * The only decision surface the job loop talks to.
 *
 * A disabled layer — the default, when the install has not opted in — returns
 * immediately and does not call the provider. Call sites keep the behaviour
 * they had before this feature existed.
 */
export interface DecisionLayer {
  readonly enabled: boolean
  kickoffExtras(args: {
    job: Job
    stateBackend: StateBackend
    logger: Logger
  }): Promise<string>
  afterPhase(args: {
    job: Job
    phaseConf: PhaseConfig | null | undefined
    checkpointPhases: ReadonlySet<string>
    stateBackend: StateBackend
    logger: Logger
  }): Promise<PhaseBoundaryAdvice>
  screenInbound(args: {
    job: Job
    events: readonly InboundEventView[]
    stateBackend: StateBackend
    logger: Logger
  }): Promise<InboundScreen>
}

class DisabledDecisionLayer implements DecisionLayer {
  readonly enabled = false

  async kickoffExtras(): Promise<string> {
    return ''
  }

  async afterPhase(): Promise<PhaseBoundaryAdvice> {
    return { consulted: false, park: false }
  }

  async screenInbound(): Promise<InboundScreen> {
    return { resume: true, warnings: [] }
  }
}

const disabledDecisionLayer: DecisionLayer = new DisabledDecisionLayer()

class ConfiguredDecisionLayer implements DecisionLayer {
  readonly enabled = true

  constructor(
    private readonly config: DecisionSettings,
    private readonly decision: DecisionProvider,
  ) {}

  async kickoffExtras(args: {
    job: Job
    stateBackend: StateBackend
    logger: Logger
  }): Promise<string> {
    let extras = ''
    if (args.job.phase === 'planning' || args.job.phase === 'spec-writing') {
      const lane = await maybeAskLane({
        config: this.config,
        job: args.job,
        decision: this.decision,
        stateBackend: args.stateBackend,
        logger: args.logger,
      })
      if (lane.advisory) extras += `${lane.advisory}\n\n`
    }
    if (args.job.phase === 'review') {
      const lens = await maybeAskReviewLens({
        config: this.config,
        job: args.job,
        decision: this.decision,
        stateBackend: args.stateBackend,
        logger: args.logger,
      })
      if (lens.hint) extras += `${lens.hint}\n\n`
    }
    return extras
  }

  async afterPhase(args: {
    job: Job
    phaseConf: PhaseConfig | null | undefined
    checkpointPhases: ReadonlySet<string>
    stateBackend: StateBackend
    logger: Logger
  }): Promise<PhaseBoundaryAdvice> {
    const outcome = await runOverseer({
      job: args.job,
      phaseConf: args.phaseConf,
      checkpointPhases: args.checkpointPhases,
      decision: this.decision,
      config: this.config,
      stateBackend: args.stateBackend,
      logger: args.logger,
    })
    const mode = this.config.sites['overseer'] ?? this.config.mode
    const park = shouldParkForOverseer({
      outcome,
      interactive: args.job.interactive,
      onFlag: this.config.overseer.onFlag,
      mode,
      approvedAdvanceFromPhase: args.job.approvedAdvanceFromPhase,
      phase: args.job.phase,
    })
    return {
      consulted: true,
      park,
      ...(outcome.flag && outcome.reason ? { flagReason: outcome.reason } : {}),
    }
  }

  async screenInbound(args: {
    job: Job
    events: readonly InboundEventView[]
    stateBackend: StateBackend
    logger: Logger
  }): Promise<InboundScreen> {
    let anyWake = false
    const warnings: string[] = []
    for (const event of args.events) {
      const wake = await maybeAskWakeGate({
        config: this.config,
        job: args.job,
        eventKey: event.eventKey,
        payload: event.payload,
        decision: this.decision,
        stateBackend: args.stateBackend,
        logger: args.logger,
      })
      if (wake.skip) {
        args.logger.info(
          { jobId: args.job.id, eventKey: event.eventKey, reason: wake.reason },
          'Wake-gate skipped resume for this event',
        )
        await args.stateBackend.appendLog(
          args.job.id,
          `[decision] wake-gate skipped ${event.eventKey}${wake.reason ? ` — ${wake.reason}` : ''}`,
        )
      } else {
        anyWake = true
      }
      const screen = await maybeAskInputScreen({
        config: this.config,
        job: args.job,
        payload: event.payload,
        decision: this.decision,
        stateBackend: args.stateBackend,
        logger: args.logger,
      })
      if (screen.warning) warnings.push(screen.warning)
    }
    return { resume: anyWake, warnings }
  }
}

/**
 * Build the layer for this process. Missing config, or a missing client,
 * yields the disabled layer. An unknown provider id is handled earlier:
 * the client factory returns the unavailable stub, and sites then no-op.
 */
export function createDecisionLayer(
  settings: Settings | undefined,
  decision: DecisionProvider | undefined,
): DecisionLayer {
  if (!settings?.decision || !decision) return disabledDecisionLayer
  return new ConfiguredDecisionLayer(settings.decision, decision)
}
