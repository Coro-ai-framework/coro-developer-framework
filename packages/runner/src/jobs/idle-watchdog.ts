import type { Logger } from 'pino'
import {
  STATUS_FAILED,
  type ConversationMessage,
  type Job,
} from '@coro-ai/cloud-protocol'
import type { Settings } from '../config/settings'
import type { StateBackend } from '../state/backend'
import type {
  DeveloperInputChannel,
  ExecutorSessionController,
} from '../plugins/types'
import { stalledJobPatch } from './helpers'

export interface IdleWatchdogConfig {
  enabled: boolean
  idleThresholdMs: number
  maxNudges: number
  checkIntervalMs: number
  stopGraceMs: number
}

export const DEFAULT_IDLE_WATCHDOG: IdleWatchdogConfig = {
  enabled: true,
  idleThresholdMs: 5 * 60 * 1000,
  maxNudges: 2,
  checkIntervalMs: 30 * 1000,
  stopGraceMs: 30 * 1000,
}

export function resolveIdleWatchdogConfig(settings: Settings): IdleWatchdogConfig {
  const raw = settings.jobs?.idleWatchdog
  if (raw?.enabled === false) {
    return { ...DEFAULT_IDLE_WATCHDOG, enabled: false }
  }
  return {
    enabled: true,
    idleThresholdMs: raw?.idleThresholdMs ?? DEFAULT_IDLE_WATCHDOG.idleThresholdMs,
    maxNudges: raw?.maxNudges ?? DEFAULT_IDLE_WATCHDOG.maxNudges,
    checkIntervalMs: raw?.checkIntervalMs ?? DEFAULT_IDLE_WATCHDOG.checkIntervalMs,
    stopGraceMs: raw?.stopGraceMs ?? DEFAULT_IDLE_WATCHDOG.stopGraceMs,
  }
}

const NUDGE_MESSAGE =
  'You appear idle. If this phase is complete, call goto_phase / await_event / escalate now. ' +
  'If you are still working, continue. If you are blocked, say what you need.'

function buildNudgeMessage(): ConversationMessage {
  return {
    role: 'user',
    content:
      `[SYSTEM NUDGE]\n` +
      `The Coro runner detected no agent activity for a while.\n\n` +
      `${NUDGE_MESSAGE}\n`,
  }
}

export interface PhaseIdleWatchdogDeps {
  config: IdleWatchdogConfig
  stateBackend: StateBackend
  logger: Logger
  getJob: () => Job
  /** Expected persisted status while the phase is actively running (e.g. `coding`). */
  getExpectedStatus: () => string
  getDeveloperInput: () => DeveloperInputChannel
  getController: () => ExecutorSessionController | undefined
  getLastActivityAt: () => number
  setLastActivityAt: (ms: number) => void
  getNudgeCount: () => number
  setNudgeCount: (n: number) => void
  isActed: () => boolean
  setActed: () => void
}

export interface PhaseIdleWatchdog {
  start(): void
  stop(): void
}

/**
 * Per-phase idle watchdog: nudge the agent when the stream is open but
 * quiet, park only after nudges are exhausted or the subprocess is wedged.
 */
export function createPhaseIdleWatchdog(deps: PhaseIdleWatchdogDeps): PhaseIdleWatchdog {
  let timer: ReturnType<typeof setInterval> | undefined
  let backstopTimer: ReturnType<typeof setTimeout> | undefined
  let parkInFlight = false

  const clearBackstop = () => {
    if (backstopTimer) {
      clearTimeout(backstopTimer)
      backstopTimer = undefined
    }
  }

  const scheduleBackstop = async () => {
    clearBackstop()
    const jobId = deps.getJob().id
    backstopTimer = setTimeout(async () => {
      try {
        const current = await deps.stateBackend.getJob(jobId)
        if (!current || current.status !== deps.getExpectedStatus()) return
        deps.logger.error(
          { jobId, phase: current.phase },
          'Idle watchdog stop() did not end phase within grace — marking job failed',
        )
        await deps.stateBackend.updateJob(jobId, {
          status: STATUS_FAILED,
          escalationMessage:
            'Agent subprocess did not stop after stall detection. Restart the job or resume from the dashboard.',
        })
        await deps.stateBackend.appendLog(
          jobId,
          '[control] Stall backstop: phase did not exit after stop() — job marked failed to free the runner slot.',
        )
      } catch (err) {
        deps.logger.warn({ jobId, err }, 'Idle watchdog backstop failed')
      }
    }, deps.config.stopGraceMs)
    backstopTimer.unref?.()
  }

  const runNudge = async () => {
    const job = deps.getJob()
    const controller = deps.getController()
    const input = deps.getDeveloperInput()
    if (!controller) return

    const inFlightMcp = controller.getSteeringState?.()?.inFlightMcpTool
    const mode = inFlightMcp ? 'safe' as const : 'urgent' as const

    input.push(buildNudgeMessage())
    deps.setNudgeCount(deps.getNudgeCount() + 1)
    deps.setLastActivityAt(Date.now())

    const nudgeNum = deps.getNudgeCount()
    await deps.stateBackend.appendLog(
      job.id,
      `[control] Idle watchdog nudge ${nudgeNum}/${deps.config.maxNudges} — prompting agent to signal or continue.`,
    )

    try {
      await controller.interrupt({ mode })
    } catch (err) {
      deps.logger.warn(
        { jobId: job.id, err, mode, inFlightMcp },
        'Idle watchdog interrupt failed — nudge is queued for next turn',
      )
    }
  }

  const runPark = async () => {
    if (parkInFlight || deps.isActed()) return
    parkInFlight = true
    deps.setActed()

    const job = deps.getJob()
    const controller = deps.getController()
    const idleMs = Date.now() - deps.getLastActivityAt()
    const idleMin = Math.max(1, Math.round(idleMs / 60_000))
    const reason =
      `Agent stalled: no progress for ~${idleMin}m after ${deps.config.maxNudges} nudge(s). ` +
      'Review the log and resume.'

    await deps.stateBackend.updateJob(job.id, stalledJobPatch(reason))
    await deps.stateBackend.appendLog(
      job.id,
      `[control] Idle watchdog parked job (stalled) — ${reason}`,
    )

    if (controller?.stop) {
      void Promise.resolve()
        .then(() => controller.stop!())
        .catch(err => {
          deps.logger.debug(
            { jobId: job.id, err },
            'Idle watchdog stop() failed — abort signal already set',
          )
        })
      await scheduleBackstop()
    } else if (controller) {
      try {
        await controller.interrupt({ mode: 'urgent' })
      } catch {
        /* best-effort */
      }
      await scheduleBackstop()
    }
  }

  const tick = async () => {
    if (!deps.config.enabled || deps.isActed() || parkInFlight) return

    const job = deps.getJob()
    if (job.status !== deps.getExpectedStatus()) return

    const idleMs = Date.now() - deps.getLastActivityAt()
    if (idleMs < deps.config.idleThresholdMs) return

    if (deps.getNudgeCount() < deps.config.maxNudges) {
      await runNudge()
      return
    }

    await runPark()
  }

  return {
    start() {
      if (!deps.config.enabled) return
      timer = setInterval(() => {
        void tick().catch(err => {
          deps.logger.warn({ err, jobId: deps.getJob().id }, 'Idle watchdog tick failed')
        })
      }, deps.config.checkIntervalMs)
      timer.unref?.()
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
      clearBackstop()
    },
  }
}
