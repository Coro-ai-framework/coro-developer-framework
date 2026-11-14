import fs from 'node:fs'
import path from 'node:path'
import type { Job } from '@coro-ai/cloud-protocol'
import { describe, expect, it } from 'vitest'
import { computeMetrics } from '../src/metrics'
import type { Timeline } from '../src/types'
import { reviewWaitMs } from '../src/watch'

const load = (name: string): Job =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'jobs', name), 'utf-8')) as Job

const timeline = (entries: Array<[number, string]>, endedAtMs: number): Timeline => ({
  dispatchedAt: new Date(0).toISOString(),
  endedAt: new Date(endedAtMs).toISOString(),
  entries: entries.map(([elapsedMs, status]) => ({ at: new Date(elapsedMs).toISOString(), elapsedMs, status, phase: '' })),
})

describe('computeMetrics on a complete job', () => {
  const job = load('job-complete.json')
  const tl = timeline(
    [
      [0, 'planning'],
      [60_000, 'coding'],
      [400_000, 'awaiting-pr-merge'],
      [460_000, 'coding'],
      [600_000, 'complete'],
    ],
    600_000,
  )
  const metrics = computeMetrics({ job, timeline: tl, outcome: 'complete' })

  it('reads cost and tokens from the job totals', () => {
    expect(metrics.costUsd).toBe(2.5)
    expect(metrics.inputTokens).toBe(1000)
    expect(metrics.outputTokens).toBe(400)
    expect(metrics.cacheReadInputTokens).toBe(5000)
    expect(metrics.cacheCreationInputTokens).toBe(700)
  })

  it('times the attempt from the timeline and the agent from the phases', () => {
    expect(metrics.wallMs).toBe(600_000)
    expect(metrics.agentMs).toBe(60_000 + 300_000 + 1_000 + 120_000 + 40_000)
  })

  it('counts time parked on a pull request as review wait', () => {
    expect(metrics.reviewWaitMs).toBe(60_000)
  })

  it('counts every phase execution and the ones the runner marked as rework', () => {
    expect(metrics.phaseRuns).toBe(5)
    expect(metrics.reworkRuns).toBe(1)
    expect(metrics.reworkCostUsd).toBe(0.5)
    expect(metrics.attributedRuns).toBe(5)
  })

  it('summarises each phase, including how often it ran', () => {
    const coding = metrics.phases.find(p => p.phase === 'coding')!
    expect(coding.runs).toBe(2)
    expect(coding.costUsd).toBe(1.7)
    expect(coding.durationMs).toBe(420_000)
    expect(coding.turns).toBe(42)
    expect(coding.reworkRuns).toBe(1)
    expect(coding.models).toEqual(['claude-sonnet-5-5'])
    expect(metrics.phases.map(p => p.phase)).toEqual(['planning', 'coding', 'review', 'evaluation'])
  })

  it('reports work items, pull requests and loops', () => {
    expect(metrics.workItemCount).toBe(2)
    expect(metrics.prCount).toBe(2)
    expect(metrics.maxLoopCount).toBe(2)
  })

  it('tallies tool failures by tool, worst first', () => {
    expect(metrics.toolCalls).toBe(8)
    expect(metrics.toolFailures).toBe(4)
    expect(metrics.failedTools).toEqual([
      { toolName: 'Bash', failures: 3 },
      { toolName: 'Write', failures: 1 },
    ])
  })

  it('carries the rate-limit retries, the outcome and the status', () => {
    expect(metrics.rateLimitRetries).toBe(2)
    expect(metrics.outcome).toBe('complete')
    expect(metrics.jobStatus).toBe('complete')
    expect(metrics.escalated).toBe(false)
  })
})

describe('computeMetrics on a job record from an older runner', () => {
  const metrics = computeMetrics({ job: load('job-legacy.json'), timeline: timeline([], 120_000), outcome: 'failed' })

  it('falls back to summing the phases when there are no job totals', () => {
    expect(metrics.costUsd).toBe(1)
    expect(metrics.inputTokens).toBe(400)
    expect(metrics.outputTokens).toBe(250)
    expect(metrics.cacheReadInputTokens).toBe(10)
  })

  it('treats missing fields as zero instead of failing', () => {
    expect(metrics.workItemCount).toBe(0)
    expect(metrics.prCount).toBe(0)
    expect(metrics.maxLoopCount).toBe(0)
    expect(metrics.toolCalls).toBe(0)
    expect(metrics.rateLimitRetries).toBe(0)
  })

  it('cannot call a run a rework when the runner did not attribute it', () => {
    expect(metrics.reworkRuns).toBe(0)
    expect(metrics.attributedRuns).toBe(0)
    expect(metrics.phaseRuns).toBe(2)
  })
})

describe('computeMetrics without any job record', () => {
  it('reports zeros and the harness outcome', () => {
    const metrics = computeMetrics({ timeline: timeline([], 5_000), outcome: 'dispatch-error' })
    expect(metrics.jobStatus).toBe('unknown')
    expect(metrics.costUsd).toBe(0)
    expect(metrics.phaseRuns).toBe(0)
    expect(metrics.wallMs).toBe(5_000)
    expect(metrics.outcome).toBe('dispatch-error')
  })

  it('flags an escalation from the status or from the recorded message', () => {
    const base = load('job-legacy.json')
    expect(computeMetrics({ job: { ...base, status: 'escalated' }, timeline: timeline([], 1), outcome: 'escalated' }).escalated).toBe(true)
    expect(
      computeMetrics({ job: { ...base, escalationMessage: 'need a decision' }, timeline: timeline([], 1), outcome: 'failed' }).escalated,
    ).toBe(true)
  })
})

describe('reviewWaitMs', () => {
  it('adds up every park on a pull request', () => {
    const tl = timeline(
      [
        [0, 'coding'],
        [10_000, 'awaiting-pr-merge'],
        [25_000, 'coding'],
        [40_000, 'awaiting-pr-merge'],
        [45_000, 'complete'],
      ],
      45_000,
    )
    expect(reviewWaitMs(tl)).toBe(15_000 + 5_000)
  })

  it('counts a park that is still going when the attempt ends', () => {
    const tl = timeline([[0, 'coding'], [10_000, 'awaiting-pr-merge']], 70_000)
    expect(reviewWaitMs(tl)).toBe(60_000)
  })

  it('is zero when the job never parked', () => {
    expect(reviewWaitMs(timeline([[0, 'coding'], [5_000, 'complete']], 5_000))).toBe(0)
  })
})
