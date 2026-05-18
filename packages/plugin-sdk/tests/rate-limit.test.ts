// Unit tests for the provider-neutral rate-limit classifier and
// backoff. The SDK intentionally knows nothing about specific
// providers (no hardcoded vendor header names, no SDK class probes);
// provider-specific knowledge is injected through `ClassifyOptions`.
// Provider-specific behaviour is covered in each executor package.

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'

import {
  RateLimitExceededError,
  classifyProviderError,
  nextBackoffMs,
  MAX_RATE_LIMIT_BACKOFF_MS,
} from '../src/rate-limit'

// A representative pair of vendor reset header names used in the
// option-driven tests. Treat as opaque strings — the SDK only does a
// case-insensitive header lookup against whatever the caller passes.
const EXTRA_RESET_HEADERS = ['x-reset-tokens', 'x-reset-requests']

describe('classifyProviderError', () => {
  it('returns null for non-error junk', () => {
    expect(classifyProviderError(null)).toBeNull()
    expect(classifyProviderError(undefined)).toBeNull()
    expect(classifyProviderError('boom')).toBeNull()
    expect(classifyProviderError(42)).toBeNull()
    expect(classifyProviderError({})).toBeNull()
  })

  it('returns null for unrelated 5xx errors', () => {
    expect(classifyProviderError({ status: 500, message: 'internal' })).toBeNull()
  })

  // ── 429 with Retry-After ────────────────────────────────────────────────

  it('parses integer Retry-After seconds', () => {
    const info = classifyProviderError({ status: 429, headers: { 'retry-after': '42' } })
    expect(info).toMatchObject({ kind: 'rate-limit', source: 'retry-after', status: 429 })
    expect(info!.retryAfterMs).toBe(42_000)
  })

  it('parses HTTP-date Retry-After', () => {
    const future = new Date(Date.now() + 15_000).toUTCString()
    const info = classifyProviderError({ status: 429, headers: { 'retry-after': future } })
    expect(info!.source).toBe('retry-after')
    // Allow a small clock skew vs Date.now().
    expect(info!.retryAfterMs).toBeGreaterThan(10_000)
    expect(info!.retryAfterMs).toBeLessThan(20_000)
  })

  // ── Caller-supplied reset headers ───────────────────────────────────────

  it('ignores unknown reset headers without extraResetHeaders option', () => {
    // Vendor headers must be opted-in by the caller; without the
    // option the SDK should see only `Retry-After`.
    const info = classifyProviderError({
      status: 429,
      headers: { 'x-reset-tokens': new Date(Date.now() + 60_000).toISOString() },
    })
    expect(info!.source).toBe('fallback')
  })

  it('parses RFC 3339 timestamp from an injected reset header', () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const info = classifyProviderError(
      { status: 429, headers: { 'x-reset-tokens': future } },
      { extraResetHeaders: EXTRA_RESET_HEADERS },
    )
    expect(info!.source).toBe('reset-header')
    expect(info!.retryAfterMs).toBeGreaterThan(55_000)
    expect(info!.retryAfterMs).toBeLessThan(65_000)
  })

  it('parses duration string from an injected reset header', () => {
    const info = classifyProviderError(
      { status: 429, headers: { 'x-reset-tokens': '6m12s' } },
      { extraResetHeaders: EXTRA_RESET_HEADERS },
    )
    expect(info!.source).toBe('reset-header')
    expect(info!.retryAfterMs).toBe(6 * 60_000 + 12 * 1000)
  })

  it('parses duration with decimal seconds', () => {
    const info = classifyProviderError(
      { status: 429, headers: { 'x-reset-requests': '1.5s' } },
      { extraResetHeaders: EXTRA_RESET_HEADERS },
    )
    expect(info!.retryAfterMs).toBe(1500)
  })

  it('parses duration with milliseconds', () => {
    const info = classifyProviderError(
      { status: 429, headers: { 'x-reset-requests': '500ms' } },
      { extraResetHeaders: EXTRA_RESET_HEADERS },
    )
    expect(info!.retryAfterMs).toBe(500)
  })

  it('takes the larger wait when multiple reset headers are set', () => {
    const info = classifyProviderError(
      {
        status: 429,
        headers: {
          'x-reset-tokens': '30s',
          'x-reset-requests': '2m',
        },
      },
      { extraResetHeaders: EXTRA_RESET_HEADERS },
    )
    expect(info!.retryAfterMs).toBe(120_000)
  })

  it('prefers Retry-After over injected reset headers', () => {
    const info = classifyProviderError(
      {
        status: 429,
        headers: {
          'retry-after': '10',
          'x-reset-tokens': '5m',
        },
      },
      { extraResetHeaders: EXTRA_RESET_HEADERS },
    )
    expect(info!.source).toBe('retry-after')
    expect(info!.retryAfterMs).toBe(10_000)
  })

  // ── Fallbacks ───────────────────────────────────────────────────────────

  it('falls back to 30s for 429 with no usable header', () => {
    const info = classifyProviderError({ status: 429, headers: {} })
    expect(info).toMatchObject({ kind: 'rate-limit', source: 'fallback' })
    expect(info!.retryAfterMs).toBe(30_000)
  })

  it('falls back to 10s for 529 overloaded', () => {
    const info = classifyProviderError({ status: 529, message: 'overloaded' })
    expect(info).toMatchObject({ kind: 'overloaded', source: 'fallback' })
    expect(info!.retryAfterMs).toBe(10_000)
  })

  // ── Caller-supplied detectors ───────────────────────────────────────────

  it('does NOT recognise vendor RateLimitError classes by itself', () => {
    // The SDK is provider-agnostic: it must not probe vendor SDK
    // class names. Detection is the caller's responsibility via
    // `ClassifyOptions.detectRateLimit`.
    class RateLimitError extends Error {
      constructor() {
        super('rate limit exceeded')
        this.name = 'RateLimitError'
      }
    }
    expect(classifyProviderError(new RateLimitError())).toBeNull()
  })

  it('uses detectRateLimit option to recognise SDK error classes', () => {
    class RateLimitError extends Error {
      constructor() {
        super('rate limit exceeded')
        this.name = 'RateLimitError'
      }
    }
    const info = classifyProviderError(new RateLimitError(), {
      detectRateLimit: (err) =>
        !!err &&
        typeof err === 'object' &&
        (err as { name?: unknown }).name === 'RateLimitError',
    })
    expect(info).toMatchObject({ kind: 'rate-limit', source: 'fallback' })
  })

  it('does NOT recognise vendor overloaded_error bodies by itself', () => {
    expect(
      classifyProviderError({
        status: 500,
        body: { error: { type: 'overloaded_error', message: 'overloaded' } },
      }),
    ).toBeNull()
  })

  it('uses detectOverloaded option to recognise embedded overload bodies', () => {
    const info = classifyProviderError(
      {
        status: 500,
        body: { error: { type: 'overloaded_error', message: 'overloaded' } },
      },
      {
        detectOverloaded: (err) => {
          if (!err || typeof err !== 'object') return false
          const body = (err as { body?: { error?: { type?: string } } }).body
          return body?.error?.type === 'overloaded_error'
        },
      },
    )
    expect(info).toMatchObject({ kind: 'overloaded' })
  })

  it('recognises nested response.status shape', () => {
    const info = classifyProviderError({ response: { status: 429 }, headers: { 'retry-after': '5' } })
    expect(info).toMatchObject({ kind: 'rate-limit', retryAfterMs: 5000 })
  })

  it('reads headers from a Fetch Headers instance', () => {
    const headers = new Headers({ 'retry-after': '7' })
    const info = classifyProviderError({ status: 429, headers })
    expect(info!.retryAfterMs).toBe(7000)
  })

  // ── Truncation ──────────────────────────────────────────────────────────

  it('truncates long error messages', () => {
    const long = 'x'.repeat(2000)
    const info = classifyProviderError({ status: 429, message: long, headers: {} })
    expect(info!.message!.length).toBeLessThanOrEqual(501)
    expect(info!.message!.endsWith('…')).toBe(true)
  })

  // ── Defensive parse guards ──────────────────────────────────────────────

  it('rejects garbled duration strings', () => {
    const info = classifyProviderError({
      status: 429,
      headers: { 'x-ratelimit-reset-tokens': 'abc6m' },
    })
    expect(info!.source).toBe('fallback')
    expect(info!.retryAfterMs).toBe(30_000)
  })
})

// ── nextBackoffMs ───────────────────────────────────────────────────────────

describe('nextBackoffMs', () => {
  beforeEach(() => {
    // Pin jitter to 1.0 (no jitter) so assertions are deterministic.
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses provider hint when larger than exponential floor', () => {
    expect(nextBackoffMs(1, 60_000)).toBe(60_000) // max(5s, 60s) = 60s
  })

  it('uses exponential floor when hint is smaller', () => {
    expect(nextBackoffMs(1, 1_000)).toBe(5_000)
    expect(nextBackoffMs(2, 1_000)).toBe(10_000)
    expect(nextBackoffMs(3, 1_000)).toBe(20_000)
    expect(nextBackoffMs(4, 1_000)).toBe(40_000)
  })

  it('caps at MAX_RATE_LIMIT_BACKOFF_MS', () => {
    expect(nextBackoffMs(20, 10 * 60 * 60 * 1000)).toBe(MAX_RATE_LIMIT_BACKOFF_MS)
  })

  it('treats attempt < 1 as attempt 1', () => {
    expect(nextBackoffMs(0, 0)).toBe(5_000)
  })

  it('applies jitter from Math.random()', () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(1)
    // jitter = 1 + (0*0.4 - 0.2) = 0.8 → 5000 * 0.8 = 4000
    expect(nextBackoffMs(1, 0)).toBe(4_000)
    // jitter = 1 + (1*0.4 - 0.2) = 1.2 → 5000 * 1.2 = 6000
    expect(nextBackoffMs(1, 0)).toBe(6_000)
  })

  it('honors hint exactly when honorHintExactly=true, bypassing cap', () => {
    // 5-hour Claude Code session-budget hint should NOT be clamped to 30min.
    const fiveHours = 5 * 60 * 60 * 1000
    expect(nextBackoffMs(1, fiveHours, { honorHintExactly: true })).toBe(fiveHours)
    // And bypass exponential floor on small hints too — server said
    // "5 seconds", we wait 5 seconds.
    expect(nextBackoffMs(3, 5_000, { honorHintExactly: true })).toBe(5_000)
  })
})

// ── RateLimitExceededError ──────────────────────────────────────────────────

describe('RateLimitExceededError', () => {
  it('carries the info and provider id', () => {
    const err = new RateLimitExceededError('anthropic', {
      kind: 'rate-limit',
      retryAfterMs: 30_000,
      source: 'retry-after',
      status: 429,
    })
    expect(err.provider).toBe('anthropic')
    expect(err.info.kind).toBe('rate-limit')
    expect(err.name).toBe('RateLimitExceededError')
    expect(err instanceof Error).toBe(true)
    expect(err instanceof RateLimitExceededError).toBe(true)
  })

  it('preserves the original error via `cause`', () => {
    const original = new Error('upstream boom')
    const err = new RateLimitExceededError(
      'openai',
      { kind: 'overloaded', retryAfterMs: 10_000, source: 'fallback' },
      { cause: original },
    )
    expect(err.cause).toBe(original)
  })
})
