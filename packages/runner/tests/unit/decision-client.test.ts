import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DecisionSettings } from '../../src/config/settings'
import { createDecisionClient } from '../../src/clients/decision'
import { JevDecisionProvider } from '../../src/plugins/builtin/jev'
import { UNAVAILABLE_REASON } from '../../src/clients/decision/unavailable'

function settings(over: Partial<DecisionSettings> = {}): DecisionSettings {
  return {
    mode: 'shadow',
    provider: 'jev',
    apiKey: 'k',
    baseUrl: 'https://example.test',
    model: 'jev-1.13.0',
    timeoutMs: 1_500,
    sites: {},
    overseer: {
      scope: 'all',
      onFlag: 'park',
      thresholds: { offTrackNoul: 0.75, severityScore: 1.5, minChoiceConfidence: 0.5 },
    },
    ...over,
  }
}

const ask = { state: 'hello', questions: { ok: { type: 'noul' as const, instructions: 'ok?' } } }

describe('createDecisionClient', () => {
  it('returns a stub when the install has not opted in', async () => {
    const client = await createDecisionClient({} as never)
    expect(client.providerId).toBe('none')
    expect(await client.ask(ask)).toEqual({ available: false, reason: UNAVAILABLE_REASON })
  })

  it('constructs a Jev provider when configured', async () => {
    const client = await createDecisionClient({ decision: settings() } as never)
    expect(client.providerId).toBe('jev')
  })

  it('stays unavailable for an unknown provider instead of guessing', async () => {
    const client = await createDecisionClient({
      decision: settings({ provider: 'someone-else' }),
    } as never)
    expect(client.providerId).toBe('none')
    expect(await client.ask(ask)).toEqual({ available: false, reason: UNAVAILABLE_REASON })
  })
})

describe('JevDecisionProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('parses a successful noul answer and never throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      model: 'jev-1.13.0',
      answers: { ok: { type: 'noul', noul: 0.82 } },
      usage: { input_tokens: 11 },
    }), { status: 200 })))

    const result = await new JevDecisionProvider(settings()).ask(ask)
    expect(result.available).toBe(true)
    if (result.available) {
      expect(result.model).toBe('jev-1.13.0')
      expect(result.inputTokens).toBe(11)
      expect(result.answers['ok']).toEqual({ type: 'noul', noul: 0.82 })
    }
  })

  it('returns unavailable on HTTP 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))
    const result = await new JevDecisionProvider(settings()).ask(ask)
    expect(result.available).toBe(false)
    if (!result.available) expect(result.reason).toContain('503')
  })

  it('returns unavailable on HTTP 429 when retry-after is too large to wait', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', {
      status: 429,
      headers: { 'retry-after': '30' },
    })))
    const result = await new JevDecisionProvider(settings()).ask(ask)
    expect(result.available).toBe(false)
    if (!result.available) expect(result.reason).toContain('429')
  })

  it('returns unavailable on malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', { status: 200 })))
    const result = await new JevDecisionProvider(settings()).ask(ask)
    expect(result.available).toBe(false)
    if (!result.available) expect(result.reason).toMatch(/non-JSON|malformed/i)
  })

  it('returns unavailable on a malformed answer payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      answers: { ok: { type: 'noul' } },
    }), { status: 200 })))
    const result = await new JevDecisionProvider(settings()).ask(ask)
    expect(result.available).toBe(false)
  })

  it('returns unavailable on abort/timeout without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }))
    const result = await new JevDecisionProvider(settings()).ask(ask)
    expect(result.available).toBe(false)
    if (!result.available) expect(result.reason).toMatch(/timed out/i)
  })

  it('returns unavailable on a network throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }))
    const result = await new JevDecisionProvider(settings()).ask(ask)
    expect(result.available).toBe(false)
    if (!result.available) expect(result.reason).toContain('ECONNREFUSED')
  })
})
