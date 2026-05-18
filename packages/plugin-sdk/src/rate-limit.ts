// ── Provider rate-limit classification & backoff ─────────────────────────────
//
// Shared, provider-neutral helpers so every LLM executor plugin
// (and the runner that catches their errors) can reason about
// rate-limit / overloaded conditions the same way. The contract is
// deliberately narrow:
//
//   1. Executors call `classifyProviderError(err)` on any exception
//      thrown by their SDK. If it returns a `RateLimitInfo`, they
//      rethrow as a `RateLimitExceededError`. Otherwise they rethrow
//      the original error untouched.
//
//   2. The runner catches `RateLimitExceededError`, parks the job
//      into `STATUS_AWAITING_RATE_LIMIT`, and uses `nextBackoffMs`
//      to compute when to auto-resume.
//
// No sleeping, retrying, or state I/O happens here — the runner owns
// the wait via its scheduler. This keeps the helpers pure and
// trivially testable.

/**
 * Why the request failed.
 *
 *   - `rate-limit` — provider returned HTTP 429 (quota exhausted).
 *   - `overloaded` — provider returned HTTP 529 (transient capacity)
 *     or an equivalent provider-specific signal surfaced via
 *     {@link ClassifyOptions.detectOverloaded}.
 *
 * Both are recoverable by waiting; the kind affects only the
 * fallback wait when the provider gives us no `Retry-After`.
 */
export type RateLimitKind = 'rate-limit' | 'overloaded'

/**
 * How we discovered `retryAfterMs`.
 *
 *   - `retry-after`  — explicit `Retry-After` header (seconds or HTTP date).
 *   - `reset-header` — provider-specific reset header surfaced via
 *     {@link ClassifyOptions.extraResetHeaders} (e.g. an `x-…-reset`
 *     header documented by the provider).
 *   - `fallback`     — no usable signal; defaulted by `kind`.
 */
export type RateLimitSource = 'retry-after' | 'reset-header' | 'fallback'

export interface RateLimitInfo {
  kind: RateLimitKind
  /** Best-effort wait hint from the provider, in milliseconds. Never negative. */
  retryAfterMs: number
  source: RateLimitSource
  /** Raw status code, when known (429 / 529 / …). For logging only. */
  status?: number
  /** Truncated provider error message, for logging only. */
  message?: string
}

/**
 * Thrown by executors when they catch a rate-limit / overloaded
 * condition from the provider SDK. The runner's top-level catch
 * tests for this with `instanceof` to distinguish recoverable
 * rate-limits from generic crashes (which mark the job FAILED and
 * clear the session).
 */
export class RateLimitExceededError extends Error {
  readonly info: RateLimitInfo
  /** Provider id, e.g. set by the executor's plugin manifest. */
  readonly provider: string

  constructor(provider: string, info: RateLimitInfo, options?: { cause?: unknown }) {
    super(
      `[${provider}] ${info.kind} (status=${info.status ?? '?'}) — retry after ${Math.round(info.retryAfterMs / 1000)}s` +
        (info.message ? `: ${info.message}` : ''),
      options,
    )
    this.name = 'RateLimitExceededError'
    this.provider = provider
    this.info = info
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Default wait when a 429 has no usable retry hint. */
const FALLBACK_RATE_LIMIT_MS = 30_000
/** Default wait when a 529 (overloaded) has no usable retry hint. */
const FALLBACK_OVERLOADED_MS = 10_000
/** Hard ceiling for `nextBackoffMs` — never wait longer than this between attempts. */
export const MAX_RATE_LIMIT_BACKOFF_MS = 30 * 60 * 1000

// ── Classifier ───────────────────────────────────────────────────────────────

/**
 * Provider-specific extension points for {@link classifyProviderError}.
 *
 * The classifier's defaults cover HTTP-level signals only (429 / 529
 * status, `Retry-After` header). Anything provider-specific — bespoke
 * error class names, embedded "overloaded" body shapes, custom reset
 * headers — must be supplied by the executor that owns the provider's
 * SDK. The shared classifier is intentionally ignorant of any
 * particular vendor.
 */
export interface ClassifyOptions {
  /**
   * Provider-specific predicate for "this is a rate-limit even though
   * the status isn't 429" (e.g. matching an SDK's `RateLimitError`
   * class). Called only when status-based detection didn't fire.
   */
  detectRateLimit?: (err: unknown) => boolean
  /**
   * Provider-specific predicate for "this is overloaded even though
   * the status isn't 529" (e.g. matching an embedded `{ error: {
   * type: 'overloaded_error' } }` body). Called only when
   * status-based detection didn't fire.
   */
  detectOverloaded?: (err: unknown) => boolean
  /**
   * Additional reset-header names to probe, in priority order. The
   * classifier always probes `Retry-After` first; provider-specific
   * headers (e.g. an `x-…-reset-tokens` documented by the provider)
   * are tried next. If multiple match, the largest wait wins.
   *
   * Header names are matched case-insensitively.
   */
  extraResetHeaders?: string[]
}

/**
 * Inspect an arbitrary exception and decide whether it represents a
 * rate-limit / overload. Returns `null` for anything we don't
 * recognise (the caller should rethrow as-is).
 *
 * The base classifier only knows HTTP-level signals:
 *   - status 429 → rate-limit
 *   - status 529 → overloaded
 *   - `Retry-After` header → exact wait
 *
 * All provider-specific knowledge (custom error class names, embedded
 * body shapes, vendor reset headers) is injected through
 * {@link ClassifyOptions} by the executor that imports this helper.
 */
export function classifyProviderError(
  err: unknown,
  options?: ClassifyOptions,
): RateLimitInfo | null {
  if (!err || typeof err !== 'object') return null

  const status = readStatus(err)
  const headers = readHeaders(err)

  // Decide kind first (so we know fallback wait if no headers).
  let kind: RateLimitKind | null = null
  if (status === 429) kind = 'rate-limit'
  else if (status === 529) kind = 'overloaded'
  else if (options?.detectRateLimit?.(err)) kind = 'rate-limit'
  else if (options?.detectOverloaded?.(err)) kind = 'overloaded'

  if (!kind) return null

  // Walk the header candidates in order; first hit wins.
  const hint = extractRetryHint(headers, options?.extraResetHeaders)

  const retryAfterMs = hint?.ms ?? (kind === 'rate-limit' ? FALLBACK_RATE_LIMIT_MS : FALLBACK_OVERLOADED_MS)
  const source: RateLimitSource = hint?.source ?? 'fallback'

  return {
    kind,
    retryAfterMs: Math.max(0, retryAfterMs),
    source,
    status: typeof status === 'number' ? status : undefined,
    message: truncateMessage(readErrorMessage(err)),
  }
}

// ── Backoff ──────────────────────────────────────────────────────────────────

/**
 * Decide how long to wait before the next attempt.
 *
 * `attempt` is 1-based: the wait *before* attempt N. We take the max
 * of (a) the provider's hint and (b) an exponential backoff floor
 * `5s * 2^(attempt-1)`, then cap at `MAX_RATE_LIMIT_BACKOFF_MS` and
 * apply ±20% jitter to spread thundering-herd wakes across jobs
 * sharing the same key.
 *
 * Rationale:
 *   - For attempt 1 the exponential floor is 5s, so a provider hint
 *     of e.g. 2s is honored as-is (`max(5s, 2s) = 5s` — small bump).
 *   - On the third retry the floor reaches 20s; even if the provider
 *     keeps saying "try in 1s" we wait longer to avoid hammering.
 *
 * `options.honorHintExactly` skips both the exponential floor and the
 * `MAX_RATE_LIMIT_BACKOFF_MS` cap — used when the hint is an
 * authoritative server-provided deadline (e.g. the Claude Code
 * subprocess `rate_limit_event.resetsAt`, which can legitimately be
 * several hours out and shouldn't be re-tried every 30 minutes).
 * Jitter is still applied (±20%) to spread thundering-herd wakes.
 */
export function nextBackoffMs(
  attempt: number,
  hintMs: number,
  options?: { honorHintExactly?: boolean },
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt))
  const jitter = 1 + (Math.random() * 0.4 - 0.2)
  if (options?.honorHintExactly) {
    return Math.round(Math.max(0, hintMs ?? 0) * jitter)
  }
  const exponentialFloor = 5_000 * 2 ** (safeAttempt - 1)
  const base = Math.max(hintMs ?? 0, exponentialFloor)
  const capped = Math.min(base, MAX_RATE_LIMIT_BACKOFF_MS)
  // ±20% jitter. `Math.random()` is fine — this is not a security boundary.
  return Math.round(capped * jitter)
}

// ── Internals ────────────────────────────────────────────────────────────────

function readStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const e = err as Record<string, unknown>
  if (typeof e.status === 'number') return e.status
  if (typeof e.statusCode === 'number') return e.statusCode
  // Some SDKs nest the response: { response: { status: 429 } }
  const response = e.response as Record<string, unknown> | undefined
  if (response && typeof response.status === 'number') return response.status
  return undefined
}

function readErrorMessage(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined
  const e = err as Record<string, unknown>
  return typeof e.message === 'string' ? e.message : undefined
}

/**
 * Pull headers out of common SDK error shapes. Supported:
 *   - `err.headers` as a plain object
 *   - `err.headers` as a `Headers` (Fetch) instance
 *   - `err.response.headers` as either of the above
 */
function readHeaders(err: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!err || typeof err !== 'object') return out
  const e = err as Record<string, unknown>
  const candidates: unknown[] = [e.headers, (e.response as Record<string, unknown> | undefined)?.headers]
  for (const candidate of candidates) {
    if (!candidate) continue
    // Fetch `Headers` instance
    if (typeof (candidate as { forEach?: unknown }).forEach === 'function' && typeof (candidate as { get?: unknown }).get === 'function') {
      ;(candidate as Headers).forEach((value, key) => {
        out[key.toLowerCase()] = value
      })
      continue
    }
    if (typeof candidate === 'object') {
      for (const [k, v] of Object.entries(candidate as Record<string, unknown>)) {
        if (typeof v === 'string') out[k.toLowerCase()] = v
        else if (typeof v === 'number') out[k.toLowerCase()] = String(v)
      }
    }
  }
  return out
}

interface RetryHint {
  ms: number
  source: 'retry-after' | 'reset-header'
}

function extractRetryHint(
  headers: Record<string, string>,
  extraResetHeaders?: string[],
): RetryHint | null {
  // Standard `Retry-After` always wins — it's the most explicit signal.
  const retryAfter = headers['retry-after']
  if (retryAfter) {
    const ms = parseRetryAfter(retryAfter)
    if (ms != null) return { ms, source: 'retry-after' }
  }

  // Provider-supplied reset headers, injected by the executor (the
  // shared classifier is ignorant of any particular vendor). If
  // multiple match, take the largest wait — a token-quota reset and
  // a request-quota reset can both fire, and the longer one is the
  // safer choice mid-phase. Header names are matched case-insensitively.
  if (extraResetHeaders && extraResetHeaders.length > 0) {
    let largest: number | null = null
    for (const name of extraResetHeaders) {
      const raw = headers[name.toLowerCase()]
      if (!raw) continue
      const ms = parseResetHeader(raw)
      if (ms == null) continue
      largest = largest == null ? ms : Math.max(largest, ms)
    }
    if (largest != null) return { ms: largest, source: 'reset-header' }
  }

  return null
}

/**
 * `Retry-After` is either delta-seconds (e.g. `"30"`) or an HTTP-date.
 * We accept both. Returns ms or null if unparseable.
 */
function parseRetryAfter(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Pure integer → seconds
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.round(Number.parseFloat(trimmed) * 1000)
  // HTTP-date → diff from now
  const parsed = Date.parse(trimmed)
  if (!Number.isNaN(parsed)) return Math.max(0, parsed - Date.now())
  return null
}

/**
 * Reset-header values seen in the wild come in three shapes; the
 * helper accepts whichever the provider emits:
 *   - RFC 3339 / ISO 8601 timestamps: `2026-05-18T12:34:56Z`
 *   - Duration strings: `6m12s`, `1.5s`, `500ms`
 *   - Bare integer seconds: `42`
 */
function parseResetHeader(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Timestamp?
  if (/[-:T]/.test(trimmed)) {
    const parsed = Date.parse(trimmed)
    if (!Number.isNaN(parsed)) return Math.max(0, parsed - Date.now())
  }

  // Duration like "6m12s", "500ms", "1.5s"
  const duration = parseDurationString(trimmed)
  if (duration != null) return duration

  // Bare seconds
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.round(Number.parseFloat(trimmed) * 1000)

  return null
}

function parseDurationString(raw: string): number | null {
  // Anchored: the whole string must be a concatenation of
  // <number><unit> tokens where unit ∈ {ms, s, m, h}. Anything else
  // (e.g. "abc6m") is rejected so we don't silently honor garbage.
  if (!/^(\d+(?:\.\d+)?(ms|s|m|h))+$/i.test(raw)) return null
  const regex = /(\d+(?:\.\d+)?)(ms|s|m|h)/gi
  let totalMs = 0
  for (const match of raw.matchAll(regex)) {
    const value = Number.parseFloat(match[1])
    const unit = match[2].toLowerCase()
    const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000
    totalMs += value * factor
  }
  return Math.round(totalMs)
}

function truncateMessage(message: string | undefined): string | undefined {
  if (!message) return undefined
  const MAX = 500
  return message.length > MAX ? message.slice(0, MAX) + '…' : message
}
