import { describe, expect, it } from 'vitest'
import { HOME_PATH } from '../src/lib/run-labels'
import {
  getJobDisplayStatus,
  getReadinessMeta,
  getRunIndicator,
  getStatusMeta,
  PAUSED_AWAITING_EVENT,
} from '../src/lib/status'

describe('display status', () => {
  it('uses one vocabulary for jobs, waits, and coordinator fallbacks', () => {
    expect(getStatusMeta('queued').label).toBe('Starting')
    expect(getStatusMeta('awaiting-developer-input').label).toBe('Needs you')
    expect(getStatusMeta('awaiting-plan-approval').label).toBe('Needs you')
    expect(getStatusMeta('awaiting-pr-merge').label).toBe('Waiting on PR')
    expect(getStatusMeta('awaiting-children').label).toBe('Waiting on sub-runs')
    expect(getStatusMeta('awaiting-rate-limit').label).toBe('Slowed')
    expect(getStatusMeta('complete').label).toBe('Done')
    expect(getStatusMeta('escalated').label).toBe('Needs escalation')
    expect(getStatusMeta('ready').label).toBe('Waiting to start')
    expect(getStatusMeta('dispatched').label).toBe('Working')
    expect(getStatusMeta('pending').label).toBe('Starting')
  })

  it('overlays Pause on the same park status as Needs you', () => {
    expect(getJobDisplayStatus({
      status: 'awaiting-developer-input',
      awaitingEvent: PAUSED_AWAITING_EVENT,
    }).label).toBe('Paused')
    expect(getJobDisplayStatus({ status: 'awaiting-developer-input' }).label).toBe('Needs you')
  })

  it('uses Ready to start for plan readiness, never a bare Ready', () => {
    expect(getReadinessMeta('ready').label).toBe('Ready to start')
    expect(getReadinessMeta('investigating').label).toBe('Investigating')
    expect(getReadinessMeta('no-run-needed').label).toBe('No run needed')
  })



})

describe('run indicator', () => {
  it('spins for a running phase, including unknown custom ones', () => {
    expect(getRunIndicator({ status: 'coding' })).toBe('running')
    expect(getRunIndicator({ status: 'some-custom-phase' })).toBe('running')
  })

  it('separates a developer pause from an agent park', () => {
    expect(getRunIndicator({
      status: 'awaiting-developer-input',
      awaitingEvent: PAUSED_AWAITING_EVENT,
    })).toBe('paused')
    expect(getRunIndicator({ status: 'awaiting-developer-input' })).toBe('waiting')
    expect(getRunIndicator({ status: 'awaiting-pr-merge' })).toBe('waiting')
  })

  it('resolves terminal states by tone', () => {
    expect(getRunIndicator({ status: 'complete' })).toBe('done')
    expect(getRunIndicator({ status: 'cancelled' })).toBe('done')
    expect(getRunIndicator({ status: 'failed' })).toBe('failed')
    expect(getRunIndicator({ status: 'escalated' })).toBe('failed')
  })
})

describe('home path', () => {
  it('is the composer root', () => {
    expect(HOME_PATH).toBe('/')
  })
})
