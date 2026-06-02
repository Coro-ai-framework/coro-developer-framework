import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import pino from 'pino'
import type { Job } from '@coro-ai/cloud-protocol'
import { STATUS_AWAITING_DEVELOPER_INPUT } from '@coro-ai/cloud-protocol'
import type { Settings } from '../../src/config/settings'
import type { StateBackend } from '../../src/state/backend'
import type {
  DeveloperInputChannel,
  ExecutorSessionController,
} from '../../src/plugins/types'
import {
  createPhaseIdleWatchdog,
  DEFAULT_IDLE_WATCHDOG,
  resolveIdleWatchdogConfig,
} from '../../src/jobs/idle-watchdog'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-idle-1',
    type: 'job' as Job['type'],
    workflowPath: '',
    params: {},
    triggerSource: 'cli',
    status: 'coding',
    phase: 'coding',
    currentWorkItem: null,
    workItems: [],
    workItemLoopCount: 0,
    prMappings: [],
    interactive: false,
    artifacts: [],
    insights: [],
    proposals: [],
    tokenUsage: undefined,
    phaseUsage: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Job
}

function makeStateBackend(job: Job): StateBackend {
  let current = { ...job }
  const logs: string[] = []
  return {
    getJob: vi.fn(async () => current),
    updateJob: vi.fn(async (_id, patch) => {
      current = { ...current, ...patch } as Job
      return current
    }),
    appendLog: vi.fn(async (_id, line) => { logs.push(line) }),
    listJobs: vi.fn(),
    createJob: vi.fn(),
    deleteJob: vi.fn(),
    listProposals: vi.fn(),
    _logs: logs,
    _job: () => current,
  } as unknown as StateBackend & { _logs: string[]; _job: () => Job }
}

describe('resolveIdleWatchdogConfig', () => {
  it('returns defaults when settings omit jobs.idleWatchdog', () => {
    const cfg = resolveIdleWatchdogConfig({} as Settings)
    expect(cfg).toEqual(DEFAULT_IDLE_WATCHDOG)
  })

  it('honours explicit overrides', () => {
    const cfg = resolveIdleWatchdogConfig({
      jobs: { idleWatchdog: { idleThresholdMs: 1_000, maxNudges: 1 } },
    } as Settings)
    expect(cfg.idleThresholdMs).toBe(1_000)
    expect(cfg.maxNudges).toBe(1)
  })

  it('disables when enabled is false', () => {
    const cfg = resolveIdleWatchdogConfig({
      jobs: { idleWatchdog: { enabled: false } },
    } as Settings)
    expect(cfg.enabled).toBe(false)
  })
})

describe('createPhaseIdleWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('nudges when idle past threshold', async () => {
    const job = makeJob()
    const backend = makeStateBackend(job)
    const pushed: unknown[] = []
    const input: DeveloperInputChannel = {
      push: (msg) => { pushed.push(msg) },
      close: () => {},
    }
    const interrupt = vi.fn().mockResolvedValue(undefined)
    const controller: ExecutorSessionController = {
      interrupt,
      getSteeringState: () => ({ inFlightMcpTool: null }),
      stop: vi.fn().mockResolvedValue(undefined),
    }

    let lastActivityAt = Date.now() - 10_000
    let nudgeCount = 0

    const watchdog = createPhaseIdleWatchdog({
      config: {
        enabled: true,
        idleThresholdMs: 5_000,
        maxNudges: 2,
        checkIntervalMs: 1_000,
        stopGraceMs: 30_000,
      },
      stateBackend: backend,
      logger: pino({ level: 'silent' }),
      getJob: () => backend._job(),
      getExpectedStatus: () => 'coding',
      getDeveloperInput: () => input,
      getController: () => controller,
      getLastActivityAt: () => lastActivityAt,
      setLastActivityAt: (ms) => { lastActivityAt = ms },
      getNudgeCount: () => nudgeCount,
      setNudgeCount: (n) => { nudgeCount = n },
      isActed: () => false,
      setActed: () => {},
    })

    watchdog.start()
    await vi.advanceTimersByTimeAsync(1_100)

    expect(nudgeCount).toBe(1)
    expect(pushed).toHaveLength(1)
    expect(interrupt).toHaveBeenCalledWith({ mode: 'urgent' })
    expect((backend as { _logs: string[] })._logs.some(l => l.includes('nudge 1/2'))).toBe(true)

    watchdog.stop()
  })

  it('parks after max nudges with no further progress', async () => {
    const job = makeJob()
    const backend = makeStateBackend(job)
    const input: DeveloperInputChannel = { push: () => {}, close: () => {} }
    const stop = vi.fn().mockResolvedValue(undefined)
    const controller: ExecutorSessionController = {
      interrupt: vi.fn().mockResolvedValue(undefined),
      stop,
    }

    let lastActivityAt = Date.now() - 60_000
    let nudgeCount = 2

    const watchdog = createPhaseIdleWatchdog({
      config: {
        enabled: true,
        idleThresholdMs: 1_000,
        maxNudges: 2,
        checkIntervalMs: 500,
        stopGraceMs: 60_000,
      },
      stateBackend: backend,
      logger: pino({ level: 'silent' }),
      getJob: () => backend._job(),
      getExpectedStatus: () => 'coding',
      getDeveloperInput: () => input,
      getController: () => controller,
      getLastActivityAt: () => lastActivityAt,
      setLastActivityAt: (ms) => { lastActivityAt = ms },
      getNudgeCount: () => nudgeCount,
      setNudgeCount: (n) => { nudgeCount = n },
      isActed: () => false,
      setActed: () => {},
    })

    watchdog.start()
    await vi.advanceTimersByTimeAsync(600)

    expect(backend._job().status).toBe(STATUS_AWAITING_DEVELOPER_INPUT)
    expect(backend._job().awaitingEvent).toMatch(/developer-input: stalled:/)
    expect(stop).toHaveBeenCalled()

    watchdog.stop()
  })

  it('does nothing when disabled', async () => {
    const job = makeJob()
    const backend = makeStateBackend(job)
    const interrupt = vi.fn()
    const controller: ExecutorSessionController = { interrupt }

    const watchdog = createPhaseIdleWatchdog({
      config: { ...DEFAULT_IDLE_WATCHDOG, enabled: false },
      stateBackend: backend,
      logger: pino({ level: 'silent' }),
      getJob: () => backend._job(),
      getExpectedStatus: () => 'coding',
      getDeveloperInput: () => ({ push: () => {}, close: () => {} }),
      getController: () => controller,
      getLastActivityAt: () => Date.now() - 999_999,
      setLastActivityAt: () => {},
      getNudgeCount: () => 0,
      setNudgeCount: () => {},
      isActed: () => false,
      setActed: () => {},
    })

    watchdog.start()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(interrupt).not.toHaveBeenCalled()
    expect(backend._job().status).toBe('coding')

    watchdog.stop()
  })
})
