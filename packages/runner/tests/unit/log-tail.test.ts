import { describe, expect, it } from 'vitest'
import { resolveLogReplayStart } from '../../src/runner/log-tail'

describe('resolveLogReplayStart', () => {
  it('replays the whole log when no tail is asked for', () => {
    expect(resolveLogReplayStart(500, undefined)).toBe(0)
    expect(resolveLogReplayStart(500, '')).toBe(0)
    expect(resolveLogReplayStart(500, 'abc')).toBe(0)
    expect(resolveLogReplayStart(500, '0')).toBe(0)
    expect(resolveLogReplayStart(500, '-5')).toBe(0)
  })

  it('starts N lines from the end when a tail is asked for', () => {
    expect(resolveLogReplayStart(500, '50')).toBe(450)
    expect(resolveLogReplayStart(500, ['50'])).toBe(450)
    expect(resolveLogReplayStart(500, 50)).toBe(450)
  })

  it('never starts before the beginning of a short log', () => {
    expect(resolveLogReplayStart(10, '50')).toBe(0)
    expect(resolveLogReplayStart(0, '50')).toBe(0)
  })
})
