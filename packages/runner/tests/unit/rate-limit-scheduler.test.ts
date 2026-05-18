// Unit tests for RateLimitScheduler — covers schedule/cancel/bootstrap
// and the race-safe `fire()` path (active job → skip, status drift → skip).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import pino from 'pino'
import { RateLimitScheduler } from '../../src/jobs/rate-limit-scheduler'
import {
  STATUS_AWAITING_RATE_LIMIT,
  STATUS_CODING,
  STATUS_CANCELLED,
} from '../../src/jobs/types'

const silentLogger = pino({ level: 'silent' }) as any

function makeBackend(jobs: any[] = []) {
  const store = new Map<string, any>()
  for (const j of jobs) store.set(j.id, j)
  return {
    listJobs: vi.fn(async () => Array.from(store.values())),
    getJob: vi.fn(async (id: string) => store.get(id) ?? null),
    setJob: (id: string, j: any) => store.set(id, j),
  } as any
}

describe('RateLimitScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('schedule() fires the resumer after the deadline', async () => {
    const resumer = {
      isActiveJob: vi.fn(() => false),
      resumeJob: vi.fn(async () => {}),
    }
    const backend = makeBackend([
      { id: 'job-1', status: STATUS_AWAITING_RATE_LIMIT },
    ])
    const s = new RateLimitScheduler(resumer, backend, silentLogger)
    s.schedule('job-1', Date.now() + 5000)

    expect(resumer.resumeJob).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5001)
    // Allow the awaited fire() promise to settle.
    await Promise.resolve()
    expect(resumer.resumeJob).toHaveBeenCalledWith('job-1')
  })

  it('cancel() prevents a scheduled fire', async () => {
    const resumer = {
      isActiveJob: vi.fn(() => false),
      resumeJob: vi.fn(async () => {}),
    }
    const s = new RateLimitScheduler(resumer, makeBackend(), silentLogger)
    s.schedule('job-1', Date.now() + 5000)
    s.cancel('job-1')
    await vi.advanceTimersByTimeAsync(10000)
    expect(resumer.resumeJob).not.toHaveBeenCalled()
  })

  it('schedule() with a past deadline fires immediately (clamped to 0)', async () => {
    const resumer = {
      isActiveJob: vi.fn(() => false),
      resumeJob: vi.fn(async () => {}),
    }
    const backend = makeBackend([
      { id: 'job-late', status: STATUS_AWAITING_RATE_LIMIT },
    ])
    const s = new RateLimitScheduler(resumer, backend, silentLogger)
    s.schedule('job-late', Date.now() - 60_000)
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    expect(resumer.resumeJob).toHaveBeenCalledWith('job-late')
  })

  it('fire() skips when the job is already active', async () => {
    const resumer = {
      isActiveJob: vi.fn(() => true),
      resumeJob: vi.fn(async () => {}),
    }
    const backend = makeBackend([
      { id: 'job-1', status: STATUS_AWAITING_RATE_LIMIT },
    ])
    const s = new RateLimitScheduler(resumer, backend, silentLogger)
    s.schedule('job-1', Date.now() + 1000)
    await vi.advanceTimersByTimeAsync(1001)
    await Promise.resolve()
    expect(resumer.resumeJob).not.toHaveBeenCalled()
  })

  it('fire() skips when job status has drifted away from awaiting-rate-limit', async () => {
    const resumer = {
      isActiveJob: vi.fn(() => false),
      resumeJob: vi.fn(async () => {}),
    }
    const backend = makeBackend([
      // Developer cancelled between park and wake-up.
      { id: 'job-1', status: STATUS_CANCELLED },
    ])
    const s = new RateLimitScheduler(resumer, backend, silentLogger)
    s.schedule('job-1', Date.now() + 1000)
    await vi.advanceTimersByTimeAsync(1001)
    await Promise.resolve()
    expect(resumer.resumeJob).not.toHaveBeenCalled()
  })

  it('bootstrap() re-arms only jobs in awaiting-rate-limit with a resumeAt', async () => {
    const resumer = {
      isActiveJob: vi.fn(() => false),
      resumeJob: vi.fn(async () => {}),
    }
    const backend = makeBackend([
      {
        id: 'parked',
        status: STATUS_AWAITING_RATE_LIMIT,
        rateLimitInfo: { resumeAt: Date.now() + 2000 },
      },
      // Missing rateLimitInfo → must be skipped (defensive).
      { id: 'parked-no-info', status: STATUS_AWAITING_RATE_LIMIT },
      // Not rate-limited → must be skipped.
      { id: 'running', status: STATUS_CODING },
    ])
    const s = new RateLimitScheduler(resumer, backend, silentLogger)
    await s.bootstrap()
    await vi.advanceTimersByTimeAsync(3000)
    await Promise.resolve()
    expect(resumer.resumeJob).toHaveBeenCalledTimes(1)
    expect(resumer.resumeJob).toHaveBeenCalledWith('parked')
  })

  it('schedule() replaces a prior pending timer for the same job', async () => {
    const resumer = {
      isActiveJob: vi.fn(() => false),
      resumeJob: vi.fn(async () => {}),
    }
    const backend = makeBackend([
      { id: 'job-1', status: STATUS_AWAITING_RATE_LIMIT },
    ])
    const s = new RateLimitScheduler(resumer, backend, silentLogger)
    s.schedule('job-1', Date.now() + 10_000) // long
    s.schedule('job-1', Date.now() + 1000) // short → wins

    await vi.advanceTimersByTimeAsync(1500)
    await Promise.resolve()
    expect(resumer.resumeJob).toHaveBeenCalledTimes(1)
  })
})
