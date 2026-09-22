import { describe, expect, it, vi } from 'vitest'
import { JobType, type Job } from '@coro-ai/cloud-protocol'
import { emptyTokenUsage } from '../../src/jobs/helpers'
import {
  evaluateOverseerFlag,
  runOverseer,
  shouldParkForOverseer,
  DEFAULT_PHASE_OBLIGATIONS,
} from '../../src/overseer'
import type { DecisionSettings } from '../../src/config/settings'
import type { DecisionProvider } from '../../src/clients/decision'
import type { StateBackend } from '../../src/state/backend'

const thresholds = { offTrackNoul: 0.75, severityScore: 1.5, minChoiceConfidence: 0.5 }

function config(over: Partial<DecisionSettings> = {}): DecisionSettings {
  return {
    mode: 'shadow',
    provider: 'jev',
    apiKey: 'k',
    baseUrl: '',
    model: 'jev-1.13.0',
    timeoutMs: 1500,
    sites: {},
    overseer: { scope: 'all', onFlag: 'park', thresholds },
    ...over,
  }
}

function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: 'job-ov',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: { description: 'Add rate limiting' },
    triggerSource: 'cli',
    status: 'running',
    phase: 'coding',
    currentWorkItem: null,
    workItems: [{ name: 'wi-1', status: 'in-progress', loopCount: 0 }],
    workItemLoopCount: 0,
    prMappings: [],
    interactive: true,
    artifacts: [],
    insights: [],
    tokenUsage: emptyTokenUsage(),
    phaseUsage: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

function backend(job: Job) {
  let stored = job
  return {
    stored: () => stored,
    api: {
      getJob: vi.fn(async () => stored),
      updateJob: vi.fn(async (_id: string, patch: Partial<Job>) => {
        stored = { ...stored, ...patch }
        return stored
      }),
      appendLog: vi.fn(async () => undefined),
    } as unknown as StateBackend,
  }
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never

describe('evaluateOverseerFlag', () => {
  it('flags drift when on-track noul is at or below 1 - threshold', () => {
    const judged = evaluateOverseerFlag(
      { off_track: { type: 'noul', noul: 0.2 } },
      thresholds,
      DEFAULT_PHASE_OBLIGATIONS,
    )
    expect(judged.flag).toBe(true)
    expect(judged.reason).toMatch(/aligned with the stated objective/)
  })

  it('does not flag drift when on-track noul is high', () => {
    expect(evaluateOverseerFlag(
      { off_track: { type: 'noul', noul: 0.9 } },
      thresholds,
      DEFAULT_PHASE_OBLIGATIONS,
    ).flag).toBe(false)
  })

  it('flags a confident obligation breach at or above the severity threshold', () => {
    const judged = evaluateOverseerFlag(
      {
        breach: { type: 'choice', choice: 'obligation[0]', confidence: 0.8 },
        severity: { type: 'score', score: 2 },
        off_track: { type: 'noul', noul: 0.9 },
      },
      thresholds,
      DEFAULT_PHASE_OBLIGATIONS,
    )
    expect(judged.flag).toBe(true)
    expect(judged.reason).toContain(DEFAULT_PHASE_OBLIGATIONS[0])
  })

  it('does not flag a `none` breach even at high confidence', () => {
    expect(evaluateOverseerFlag(
      {
        breach: { type: 'choice', choice: 'none', confidence: 0.99 },
        severity: { type: 'score', score: 3 },
      },
      thresholds,
      DEFAULT_PHASE_OBLIGATIONS,
    ).flag).toBe(false)
  })
})

describe('shouldParkForOverseer', () => {
  const flagged = { called: true, flag: true, reason: 'off track' }

  it('parks only live + park + interactive + flagged, and not after an approval waiver', () => {
    expect(shouldParkForOverseer({
      outcome: flagged, interactive: true, onFlag: 'park', mode: 'live', phase: 'coding',
    })).toBe(true)
    expect(shouldParkForOverseer({
      outcome: flagged, interactive: true, onFlag: 'park', mode: 'shadow', phase: 'coding',
    })).toBe(false)
    expect(shouldParkForOverseer({
      outcome: flagged, interactive: false, onFlag: 'park', mode: 'live', phase: 'coding',
    })).toBe(false)
    expect(shouldParkForOverseer({
      outcome: flagged, interactive: true, onFlag: 'flag-only', mode: 'live', phase: 'coding',
    })).toBe(false)
    expect(shouldParkForOverseer({
      outcome: flagged, interactive: true, onFlag: 'park', mode: 'live',
      approvedAdvanceFromPhase: 'coding', phase: 'coding',
    })).toBe(false)
    expect(shouldParkForOverseer({
      outcome: { called: true, flag: false }, interactive: true, onFlag: 'park', mode: 'live', phase: 'coding',
    })).toBe(false)
  })
})

describe('runOverseer', () => {
  it('does not call the provider when the site is off', async () => {
    const ask = vi.fn()
    const decision: DecisionProvider = { providerId: 'jev', ask }
    const { api } = backend(makeJob())
    const outcome = await runOverseer({
      job: makeJob(),
      phaseConf: null,
      checkpointPhases: new Set(),
      decision,
      config: config({ sites: { overseer: 'off' } }),
      stateBackend: api,
      logger,
    })
    expect(outcome).toEqual({ called: false, flag: false })
    expect(ask).not.toHaveBeenCalled()
  })

  it('skips non-campaign jobs when scope is campaigns', async () => {
    const ask = vi.fn()
    const outcome = await runOverseer({
      job: makeJob(),
      phaseConf: null,
      checkpointPhases: new Set(),
      decision: { providerId: 'jev', ask },
      config: config({ overseer: { scope: 'campaigns', onFlag: 'park', thresholds } }),
      stateBackend: backend(makeJob()).api,
      logger,
    })
    expect(outcome.called).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it('fail-opens when the provider is unavailable', async () => {
    const { api, stored } = backend(makeJob())
    const outcome = await runOverseer({
      job: makeJob(),
      phaseConf: null,
      checkpointPhases: new Set(),
      decision: { providerId: 'jev', ask: async () => ({ available: false, reason: 'down' }) },
      config: config(),
      stateBackend: api,
      logger,
    })
    expect(outcome).toEqual({ called: false, flag: false })
    expect(stored().decisionRecords).toBeUndefined()
  })

  it('fail-opens when the provider throws', async () => {
    const outcome = await runOverseer({
      job: makeJob(),
      phaseConf: null,
      checkpointPhases: new Set(),
      decision: { providerId: 'jev', ask: async () => { throw new Error('boom') } },
      config: config(),
      stateBackend: backend(makeJob()).api,
      logger,
    })
    expect(outcome).toEqual({ called: false, flag: false })
  })

  it('records a flagged shadow call without marking it acted on', async () => {
    const { api, stored } = backend(makeJob())
    const outcome = await runOverseer({
      job: makeJob(),
      phaseConf: null,
      checkpointPhases: new Set(),
      decision: {
        providerId: 'jev',
        ask: async () => ({
          available: true,
          model: 'jev-1.13.0',
          latencyMs: 40,
          inputTokens: 9,
          answers: {
            off_track: { type: 'noul', noul: 0.1 },
            breach: { type: 'choice', choice: 'none', confidence: 0.9, probabilities: { none: 0.9 } },
            severity: { type: 'score', score: 0, confidence: 0.9, probabilities: {} },
            blocked: { type: 'noul', noul: 0.1 },
          },
        }),
      },
      config: config(),
      stateBackend: api,
      logger,
    })
    expect(outcome.called).toBe(true)
    expect(outcome.flag).toBe(true)
    expect(stored().decisionRecords).toHaveLength(1)
    expect(stored().decisionRecords?.[0]?.actedOn).toBeUndefined()
    expect(stored().decisionRecords?.[0]?.flagReason).toMatch(/aligned/)
  })
})
