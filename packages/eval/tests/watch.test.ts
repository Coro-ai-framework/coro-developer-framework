import type { Job } from '@coro-ai/cloud-protocol'
import { describe, expect, it } from 'vitest'
import type { ReviewerAction } from '../src/reviewer'
import { watchJob, type WatchOptions } from '../src/watch'

const job = (status: string, phase = 'coding', extra: Partial<Job> = {}): Job => ({ id: 'j1', status, phase, ...extra }) as unknown as Job

/** A virtual clock: `sleep` advances time instead of waiting. */
function harness(script: Array<Job | Error>, overrides: Partial<WatchOptions> = {}) {
  let clock = Date.parse('2024-01-01T00:00:00Z')
  let polls = 0
  const cancelled: string[] = []
  const reviewerSaw: string[] = []
  let reviewerActions: ReviewerAction[][] = []

  const options: WatchOptions = {
    client: {
      async getJob() {
        const item = script[Math.min(polls++, script.length - 1)]!
        if (item instanceof Error) throw item
        return item
      },
      async cancel(id) {
        cancelled.push(id)
      },
    },
    reviewer: {
      async tick(j) {
        reviewerSaw.push(j.status)
        return reviewerActions.shift() ?? []
      },
    },
    jobId: 'j1',
    timeoutMs: 600_000,
    pollMs: 5_000,
    needsHumanGraceMs: 30_000,
    runnerAlive: () => true,
    now: () => clock,
    sleep: async ms => {
      clock += ms
    },
    ...overrides,
  }
  return {
    options,
    cancelled,
    reviewerSaw,
    polls: () => polls,
    setReviewerActions: (actions: ReviewerAction[][]) => {
      reviewerActions = actions
    },
  }
}

describe('watchJob', () => {
  it('ends as complete when the job completes, and keeps the final record', async () => {
    const h = harness([job('planning', 'planning'), job('coding'), job('complete', 'evaluation')])
    const result = await watchJob(h.options)
    expect(result.outcome).toBe('complete')
    expect(result.job?.status).toBe('complete')
    expect(h.cancelled).toEqual([])
  })

  it.each([
    ['failed', 'failed'],
    ['escalated', 'escalated'],
    ['cancelled', 'cancelled'],
  ] as const)('maps %s to the %s outcome', async (status, outcome) => {
    const result = await watchJob(harness([job(status)]).options)
    expect(result.outcome).toBe(outcome)
  })

  it('records the timeline when status or phase changes, not on every poll', async () => {
    const h = harness([job('planning', 'planning'), job('planning', 'planning'), job('coding'), job('coding'), job('complete', 'evaluation')])
    const { timeline } = await watchJob(h.options)
    expect(timeline.entries.map(e => `${e.status}/${e.phase}`)).toEqual(['planning/planning', 'coding/coding', 'complete/evaluation'])
    expect(timeline.entries.map(e => e.elapsedMs)).toEqual([0, 10_000, 20_000])
    expect(timeline.dispatchedAt).toBe('2024-01-01T00:00:00.000Z')
    expect(timeline.endedAt).toBe('2024-01-01T00:00:20.000Z')
  })

  it('lets the reviewer look at every poll and logs what it did', async () => {
    const h = harness([job('awaiting-pr-merge', 'review'), job('awaiting-pr-merge', 'review'), job('complete')])
    h.setReviewerActions([[{ kind: 'approved', prId: '1' }]])
    const { timeline } = await watchJob(h.options)
    expect(h.reviewerSaw).toEqual(['awaiting-pr-merge', 'awaiting-pr-merge', 'complete'])
    expect(timeline.entries.some(e => e.event === 'reviewer: approved PR 1')).toBe(true)
  })

  it('survives a reviewer that throws, and says so once', async () => {
    const h = harness([job('coding'), job('coding'), job('complete')], {
      reviewer: {
        async tick() {
          throw new Error('disk full')
        },
      },
    })
    const { outcome, timeline } = await watchJob(h.options)
    expect(outcome).toBe('complete')
    expect(timeline.entries.filter(e => e.event?.startsWith('reviewer error')).length).toBe(1)
  })

  it('tolerates a failed poll while the runner is alive', async () => {
    const h = harness([job('coding'), new Error('ECONNRESET'), new Error('ECONNRESET'), job('complete')])
    expect((await watchJob(h.options)).outcome).toBe('complete')
  })

  it('ends as runner-crashed when the process is gone', async () => {
    let alive = true
    const h = harness([job('coding'), job('coding')], { runnerAlive: () => alive })
    h.options.sleep = async ms => {
      alive = false
      await Promise.resolve(ms)
    }
    const result = await watchJob(h.options)
    expect(result.outcome).toBe('runner-crashed')
    expect(result.error).toMatch(/runner process exited/)
  })

  it('ends as runner-crashed when polls keep failing and the process has died', async () => {
    let polls = 0
    const h = harness([new Error('connection refused')], {
      runnerAlive: () => polls < 7,
    })
    const original = h.options.client.getJob
    h.options.client.getJob = async id => {
      polls++
      return original(id)
    }
    expect((await watchJob(h.options)).outcome).toBe('runner-crashed')
  })

  it('cancels at the timeout and waits for the job to stop', async () => {
    const h = harness([job('coding'), job('coding'), job('coding'), job('cancelled')], { timeoutMs: 10_000 })
    const result = await watchJob(h.options)
    expect(result.outcome).toBe('timeout')
    expect(h.cancelled).toEqual(['j1'])
    expect(result.job?.status).toBe('cancelled')
    expect(result.timeline.entries.some(e => e.event?.includes('timeout'))).toBe(true)
  })

  it('still reports a timeout if the cancel call fails', async () => {
    const h = harness([job('coding')], { timeoutMs: 10_000 })
    h.options.client.cancel = async () => {
      throw new Error('already stopped')
    }
    const result = await watchJob(h.options)
    expect(result.outcome).toBe('timeout')
  })

  it('gives a job parked for a person a grace period, then calls it needs-human', async () => {
    const h = harness([job('coding'), job('awaiting-developer-input', 'planning', { awaitingEvent: 'developer-input' } as Partial<Job>)])
    const result = await watchJob(h.options)
    expect(result.outcome).toBe('needs-human')
    expect(result.error).toMatch(/awaiting-developer-input/)
    const parkedAt = result.timeline.entries.find(e => e.status === 'awaiting-developer-input')!.elapsedMs
    expect(result.timeline.endedAt).toBe(new Date(Date.parse(result.timeline.dispatchedAt) + parkedAt + 30_000).toISOString())
  })

  it('treats plan approval the same way', async () => {
    const result = await watchJob(harness([job('awaiting-plan-approval', 'planning')]).options)
    expect(result.outcome).toBe('needs-human')
  })

  it('does not call a momentary park needs-human', async () => {
    const h = harness([job('awaiting-developer-input'), job('coding'), job('complete')])
    expect((await watchJob(h.options)).outcome).toBe('complete')
  })

  it('does not treat a park on a pull request as needing a person', async () => {
    const parked = Array.from({ length: 20 }, () => job('awaiting-pr-merge', 'review'))
    const h = harness([...parked, job('complete')])
    expect((await watchJob(h.options)).outcome).toBe('complete')
  })

  it('records the job the last successful poll returned when the runner dies', async () => {
    let calls = 0
    const h = harness([job('coding', 'coding', { id: 'seen' } as Partial<Job>)], { runnerAlive: () => calls++ < 1 })
    const result = await watchJob(h.options)
    expect(result.outcome).toBe('runner-crashed')
    expect(result.job?.id).toBe('seen')
  })
})
