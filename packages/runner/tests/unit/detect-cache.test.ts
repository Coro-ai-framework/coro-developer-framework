import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  storeDetectCandidates,
  takeDetectCandidate,
  clearDetectCache,
} from '../../src/plugins/detect-cache'

describe('detect-cache', () => {
  beforeEach(() => {
    clearDetectCache()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns candidate without config in public shape', async () => {
    storeDetectCandidates('github', [
      {
        id: 'c1',
        sourceLabel: 'GitHub CLI',
        config: { token: 'secret' },
        preview: [{ label: 'Token', value: 'ghp_…' }],
      },
    ])
    const taken = takeDetectCandidate('github', 'c1')
    expect(taken?.config.token).toBe('secret')
  })

  it('expires entries after TTL', () => {
    storeDetectCandidates('github', [
      {
        id: 'c1',
        sourceLabel: 'GitHub CLI',
        config: { token: 'secret' },
        preview: [],
      },
    ])
    vi.advanceTimersByTime(11 * 60 * 1000)
    expect(takeDetectCandidate('github', 'c1')).toBeNull()
  })
})
