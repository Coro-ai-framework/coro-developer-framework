import { describe, expect, it, vi } from 'vitest'
import { PAUSED_AWAITING_EVENT, type Job } from '@coro-ai/cloud-protocol'
import {
  buildRunControlTools,
  executeRunControl,
  readRunLog,
  RUN_CONTROL_TOOL_NAMES,
  RUN_LOG_MAX_CHARS,
  RUN_RELAY_PREFIX,
  type RunControl,
} from '../../src/intake/run-control'
import { createIntakeRunTool } from '../../src/intake/tools'
import { PluginRegistry } from '../../src/plugins/registry'
import { makeMockJob } from '../mcp/fixtures'

const SESSION = 'conv-1'

function job(overrides: Partial<Job> = {}): Job {
  return makeMockJob({ id: 'job-1', params: { investigationId: SESSION }, ...overrides }) as unknown as Job
}

function harness(current: Job) {
  const runControl: RunControl = {
    sendMessage: vi.fn(async () => undefined),
    pauseJob: vi.fn(async () => ({ ...current, status: 'awaiting-developer-input' })),
    resumeJob: vi.fn(async () => undefined),
    cancelJob: vi.fn(async () => ({ ...current, status: 'cancelled' })),
    setJobInteractive: vi.fn(async (_id: string, value: boolean) => ({ ...current, interactive: value })),
  }
  const stateBackend = {
    getJob: vi.fn(async (id: string) => (id === current.id ? current : null)),
    appendLog: vi.fn(async () => undefined),
  }
  return { runControl, stateBackend, deps: { runControl, stateBackend, sessionId: SESSION } }
}

describe('executeRunControl', () => {
  it('refuses a run another conversation started, without touching it', async () => {
    const { runControl, deps } = harness(job({ params: { investigationId: 'someone-else' } }))
    for (const name of RUN_CONTROL_TOOL_NAMES) {
      await expect(executeRunControl(name, { jobId: 'job-1', message: 'm', reason: 'r', interactive: true }, deps))
        .rejects.toThrow('not started by this conversation')
    }
    expect(Object.values(runControl).every(fn => vi.mocked(fn).mock.calls.length === 0)).toBe(true)
  })

  it('steers a working run with the relay prefix and records who acted', async () => {
    const { runControl, stateBackend, deps } = harness(job({ status: 'coding' }))
    await expect(executeRunControl('message_run', { jobId: 'job-1', message: 'also cover X' }, deps))
      .resolves.toEqual({ sent: true, status: 'coding' })
    expect(runControl.sendMessage).toHaveBeenCalledWith('job-1', `${RUN_RELAY_PREFIX}also cover X`)
    expect(stateBackend.appendLog).toHaveBeenCalledWith('job-1', `[control] Plan conversation ${SESSION}: message_run`)
  })

  it('will not steer a stopped run, because a message would resume it', async () => {
    for (const status of ['awaiting-developer-input', 'awaiting-pr-merge', 'escalated', 'failed']) {
      const { runControl, deps } = harness(job({ status, awaitingEvent: PAUSED_AWAITING_EVENT }))
      await expect(executeRunControl('message_run', { jobId: 'job-1', message: 'm' }, deps)).rejects.toThrow('answer_run')
      expect(runControl.sendMessage).not.toHaveBeenCalled()
    }
  })

  it('will not message a finished run; that would reopen it', async () => {
    const { runControl, deps } = harness(job({ status: 'complete' }))
    await expect(executeRunControl('message_run', { jobId: 'job-1', message: 'm' }, deps)).rejects.toThrow('<run>')
    await expect(executeRunControl('answer_run', { jobId: 'job-1', message: 'm' }, deps)).rejects.toThrow('<run>')
    expect(runControl.sendMessage).not.toHaveBeenCalled()
  })

  it('answers any stopped run and refuses a working one', async () => {
    for (const status of ['awaiting-developer-input', 'awaiting-plan-approval', 'escalated', 'failed']) {
      const { runControl, deps } = harness(job({ status }))
      await executeRunControl('answer_run', { jobId: 'job-1', message: 'use v3' }, deps)
      expect(runControl.sendMessage).toHaveBeenCalledWith('job-1', `${RUN_RELAY_PREFIX}use v3`)
    }
    const { deps } = harness(job({ status: 'coding' }))
    await expect(executeRunControl('answer_run', { jobId: 'job-1', message: 'm' }, deps)).rejects.toThrow('message_run')
  })

  it('requires a reason to cancel and a boolean to change mode', async () => {
    const { runControl, deps } = harness(job({ status: 'coding' }))
    await expect(executeRunControl('cancel_run', { jobId: 'job-1' }, deps)).rejects.toThrow('reason')
    await expect(executeRunControl('set_run_mode', { jobId: 'job-1', interactive: 'yes' }, deps)).rejects.toThrow('interactive')
    expect(runControl.cancelJob).not.toHaveBeenCalled()
    await expect(executeRunControl('set_run_mode', { jobId: 'job-1', interactive: true }, deps)).resolves.toEqual({ interactive: true })
  })
})

describe('run-control tool gating', () => {
  const registry = new PluginRegistry()

  it('fails closed when no approval broker is present', async () => {
    const { runControl, stateBackend } = harness(job({ status: 'coding' }))
    const runTool = createIntakeRunTool(registry, new AbortController().signal, {
      runControl,
      stateBackend: stateBackend as never,
      sessionId: SESSION,
    })
    await expect(runTool('message_run', { jobId: 'job-1', message: 'm' })).rejects.toThrow('approvals are not active')
    expect(runControl.sendMessage).not.toHaveBeenCalled()
  })

  it('surfaces a declined approval and does not act', async () => {
    const { runControl, stateBackend } = harness(job({ status: 'coding' }))
    const runTool = createIntakeRunTool(registry, new AbortController().signal, {
      runControl,
      stateBackend: stateBackend as never,
      sessionId: SESSION,
      gate: async () => ({ allow: false, reason: 'Declined by the developer.' }),
    })
    await expect(runTool('message_run', { jobId: 'job-1', message: 'm' })).rejects.toThrow('Declined by the developer.')
    expect(runControl.sendMessage).not.toHaveBeenCalled()
  })

  it('declares exactly the tools the gate knows about', () => {
    expect(new Set(buildRunControlTools().map(t => t.name))).toEqual(RUN_CONTROL_TOOL_NAMES)
  })
})

describe('readRunLog', () => {
  function logBackend(lines: string[]) {
    return {
      getJob: async () => job({ status: 'coding', phase: 'coding' }),
      logLength: async () => lines.length,
      getLog: async (_id: string, start = 0) => lines.slice(start),
    }
  }

  it('returns the tail and drops the system prompt', async () => {
    const lines = ['2026-01-01T00:00:00.000Z System prompt: secret', ...Array.from({ length: 10 }, (_, i) => `line ${i}`)]
    const result = await readRunLog({ jobId: 'job-1', tail: 3 }, logBackend(lines))
    expect(result.lines).toEqual(['line 7', 'line 8', 'line 9'])
    expect(result).toMatchObject({ status: 'coding', totalLines: 11 })
  })

  it('filters case-insensitively', async () => {
    const result = await readRunLog({ jobId: 'job-1', contains: 'ERROR' }, logBackend(['ok', '[error] boom', 'ok']))
    expect(result.lines).toEqual(['[error] boom'])
  })

  it('caps the size it returns, keeping the newest lines', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `${i} ${'x'.repeat(500)}`)
    const result = await readRunLog({ jobId: 'job-1', tail: 200 }, logBackend(lines))
    expect(result.lines.join('\n').length).toBeLessThanOrEqual(RUN_LOG_MAX_CHARS)
    expect(result.lines.at(-1)?.startsWith('199 ')).toBe(true)
    expect(result.truncated).toBe(true)
  })
})
