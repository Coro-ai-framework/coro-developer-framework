import { describe, expect, it, vi } from 'vitest'
import { JobType, type Job } from '@coro-ai/cloud-protocol'
import { emptyTokenUsage } from '../../src/jobs/helpers'
import type { DecisionSettings } from '../../src/config/settings'
import type { StateBackend } from '../../src/state/backend'
import {
  isBotWebhookAuthor,
  maybeAskWakeGate,
  maybeAskLane,
} from '../../src/decision/sites'
import { summarizeDecisionRecords } from '../../src/decision/shadow-report'

function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: 'job-site',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: { description: 'Add rate limiting' },
    triggerSource: 'cli',
    status: 'awaiting-pr-merge',
    phase: 'review',
    currentWorkItem: null,
    workItems: [],
    workItemLoopCount: 0,
    prMappings: [],
    interactive: false,
    artifacts: [],
    insights: [],
    tokenUsage: emptyTokenUsage(),
    phaseUsage: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

const liveConfig: DecisionSettings = {
  mode: 'live',
  provider: 'jev',
  apiKey: 'k',
  baseUrl: '',
  model: 'jev-1.13.0',
  timeoutMs: 1500,
  sites: {},
  overseer: {
    scope: 'all',
    onFlag: 'park',
    thresholds: { offTrackNoul: 0.75, severityScore: 1.5, minChoiceConfidence: 0.5 },
  },
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never

function backend(job: Job): StateBackend {
  let stored = job
  return {
    getJob: vi.fn(async () => stored),
    updateJob: vi.fn(async (_id: string, patch: Partial<Job>) => {
      stored = { ...stored, ...patch }
      return stored
    }),
    appendLog: vi.fn(async () => undefined),
  } as unknown as StateBackend
}

describe('isBotWebhookAuthor', () => {
  it('detects GitHub bot senders before any model call', () => {
    expect(isBotWebhookAuthor({ sender: { login: 'dependabot[bot]', type: 'Bot' } })).toBe(true)
    expect(isBotWebhookAuthor({ sender: { login: 'alice', type: 'User' } })).toBe(false)
    expect(isBotWebhookAuthor({ comment: { user: { login: 'renovate[bot]' } } })).toBe(true)
  })
})

describe('maybeAskWakeGate', () => {
  it('skips resume for bots in live mode without calling the provider', async () => {
    const ask = vi.fn()
    const result = await maybeAskWakeGate({
      config: liveConfig,
      job: makeJob(),
      eventKey: 'pr:commented',
      payload: { sender: { login: 'dependabot[bot]', type: 'Bot' } },
      decision: { providerId: 'jev', ask },
      stateBackend: backend(makeJob()),
      logger,
    })
    expect(result.skip).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('still resumes for bots in shadow mode', async () => {
    const result = await maybeAskWakeGate({
      config: { ...liveConfig, mode: 'shadow' },
      job: makeJob(),
      eventKey: 'pr:commented',
      payload: { sender: { login: 'dependabot[bot]', type: 'Bot' } },
      decision: { providerId: 'jev', ask: vi.fn() },
      stateBackend: backend(makeJob()),
      logger,
    })
    expect(result.skip).toBe(false)
  })

  it('skips resume in live mode when worth_waking noul is low', async () => {
    const result = await maybeAskWakeGate({
      config: liveConfig,
      job: makeJob(),
      eventKey: 'pr:commented',
      payload: { sender: { login: 'alice', type: 'User' }, comment: { body: 'lgtm' } },
      decision: {
        providerId: 'jev',
        ask: async () => ({
          available: true,
          model: 'jev-1.13.0',
          latencyMs: 12,
          inputTokens: 3,
          answers: { worth_waking: { type: 'noul', noul: 0.1 } },
        }),
      },
      stateBackend: backend(makeJob()),
      logger,
    })
    expect(result.skip).toBe(true)
  })
})

describe('maybeAskLane', () => {
  it('never auto-switches; live only returns an advisory', async () => {
    const result = await maybeAskLane({
      config: liveConfig,
      job: makeJob({ phase: 'planning' }),
      decision: {
        providerId: 'jev',
        ask: async () => ({
          available: true,
          model: 'jev-1.13.0',
          latencyMs: 12,
          inputTokens: 3,
          answers: { stay: { type: 'noul', noul: 0.2 } },
        }),
      },
      stateBackend: backend(makeJob()),
      logger,
    })
    expect(result.advisory).toMatch(/not an instruction to switch/)
  })
})

describe('summarizeDecisionRecords', () => {
  it('aggregates latency, flags, and per-site counts', () => {
    const summary = summarizeDecisionRecords([
      makeJob({
        decisionRecords: [
          {
            id: 'a', site: 'overseer', at: 't', phase: 'coding', mode: 'shadow',
            model: 'jev-1.13.0', latencyMs: 40, inputTokens: 10, answers: {},
            flagReason: 'drift',
          },
          {
            id: 'b', site: 'wake-gate', at: 't', phase: 'review', mode: 'live',
            model: 'jev-1.13.0', latencyMs: 20, inputTokens: 4, answers: {},
            actedOn: true,
          },
        ],
      }),
    ])
    expect(summary.recorded).toBe(2)
    expect(summary.flagged).toBe(1)
    expect(summary.actedOn).toBe(1)
    expect(summary.avgLatencyMs).toBe(30)
    expect(summary.bySite['overseer']?.calls).toBe(1)
    expect(summary.bySite['wake-gate']?.actedOn).toBe(1)
  })
})
