import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DECISION_DEFAULT_MIN_CHOICE_CONFIDENCE,
  DECISION_DEFAULT_MODEL,
  DECISION_DEFAULT_OFF_TRACK_NOUL,
  DECISION_DEFAULT_SEVERITY_SCORE,
  DECISION_DEFAULT_TIMEOUT_MS,
  resolveDecisionConfig,
} from '../../src/config/local-config'

const ENV_KEYS = [
  'CORO_DECISION_MODE',
  'CORO_DECISION_API_KEY',
  'CORO_DECISION_BASE_URL',
  'CORO_DECISION_MODEL',
  'TYPESAFE_API_KEY',
] as const

describe('resolveDecisionConfig', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('stays undefined until both a non-off mode and an API key are set', () => {
    expect(resolveDecisionConfig(null)).toBeUndefined()
    expect(resolveDecisionConfig({})).toBeUndefined()
    expect(resolveDecisionConfig({ decision: { mode: 'shadow' } })).toBeUndefined()
    expect(resolveDecisionConfig({ decision: { apiKey: 'k' } })).toBeUndefined()
    expect(resolveDecisionConfig({ decision: { mode: 'off', apiKey: 'k' } })).toBeUndefined()
  })

  it('resolves shadow with defaults when a key is present', () => {
    const resolved = resolveDecisionConfig({
      decision: { mode: 'shadow', apiKey: 'k' },
    })
    expect(resolved).toEqual({
      mode: 'shadow',
      provider: 'jev',
      apiKey: 'k',
      baseUrl: '',
      model: DECISION_DEFAULT_MODEL,
      timeoutMs: DECISION_DEFAULT_TIMEOUT_MS,
      sites: {},
      overseer: {
        scope: 'all',
        onFlag: 'park',
        thresholds: {
          offTrackNoul: DECISION_DEFAULT_OFF_TRACK_NOUL,
          severityScore: DECISION_DEFAULT_SEVERITY_SCORE,
          minChoiceConfidence: DECISION_DEFAULT_MIN_CHOICE_CONFIDENCE,
        },
      },
    })
  })

  it('honours per-site overrides and overseer thresholds', () => {
    const resolved = resolveDecisionConfig({
      decision: {
        mode: 'shadow',
        apiKey: 'k',
        sites: { overseer: 'live', 'wake-gate': 'off' },
        overseer: {
          scope: 'campaigns',
          onFlag: 'flag-only',
          thresholds: { offTrackNoul: 0.9, severityScore: 2, minChoiceConfidence: 0.8 },
        },
      },
    })
    expect(resolved?.sites).toEqual({ overseer: 'live', 'wake-gate': 'off' })
    expect(resolved?.overseer).toEqual({
      scope: 'campaigns',
      onFlag: 'flag-only',
      thresholds: { offTrackNoul: 0.9, severityScore: 2, minChoiceConfidence: 0.8 },
    })
  })

  it('falls back to environment when the config block is absent', () => {
    process.env.CORO_DECISION_MODE = 'live'
    process.env.CORO_DECISION_API_KEY = 'env-key'
    process.env.CORO_DECISION_MODEL = 'jev-1.13.0'
    const resolved = resolveDecisionConfig({})
    expect(resolved).toMatchObject({
      mode: 'live',
      apiKey: 'env-key',
      model: 'jev-1.13.0',
    })
  })

  it('accepts TYPESAFE_API_KEY as a last-resort key fallback', () => {
    process.env.CORO_DECISION_MODE = 'shadow'
    process.env.TYPESAFE_API_KEY = 'legacy-key'
    expect(resolveDecisionConfig({})?.apiKey).toBe('legacy-key')
  })
})
