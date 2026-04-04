import { Settings } from '../config/settings'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TempoTrace {
  traceID: string
  rootServiceName: string
  rootTraceName: string
  startTimeUnixNano: string
  durationMs: number
  spanSets?: TempoSpanSet[]
}

export interface TempoSpanSet {
  spans: TempoSpan[]
  matched: number
}

export interface TempoSpan {
  spanID: string
  startTimeUnixNano: string
  durationNanos: number
  attributes: { key: string; value: { stringValue?: string; intValue?: number } }[]
}

export interface TempoSearchResult {
  available: true
  traces: TempoTrace[]
}

export interface TempoUnavailableResult {
  available: false
  reason: string
}

export type TempoResult = TempoSearchResult | TempoUnavailableResult

// ── Client ────────────────────────────────────────────────────────────────────

/**
 * Tempo HTTP API client.
 *
 * Returns `{ available: false }` if Tempo is not configured.
 */
export class TempoClient {
  private readonly available: boolean

  constructor(private readonly settings: { baseUrl: string; apiKey: string }) {
    this.available = settings.baseUrl.length > 0
  }

  /**
   * Fetch a single trace by ID.
   * Returns the full trace with all spans.
   */
  async getTrace(traceId: string): Promise<{ available: true; trace: unknown } | TempoUnavailableResult> {
    if (!this.available) {
      return { available: false, reason: 'Tempo not configured (tempo.baseUrl is empty)' }
    }

    const url = `${this.settings.baseUrl}/api/traces/${traceId}`
    const res = await fetch(url, { headers: this.headers() })

    if (!res.ok) {
      const text = await res.text()
      return { available: false, reason: `Tempo getTrace failed (${res.status}): ${text}` }
    }

    const trace = await res.json()
    return { available: true, trace }
  }

  /**
   * Search for traces matching a TraceQL query.
   *
   * @param query   TraceQL query, e.g. `{ .service.name = "my-service" && status = error }`
   * @param start   Start time (Unix seconds or RFC3339)
   * @param end     End time (Unix seconds or RFC3339, default: now)
   * @param limit   Max traces to return (default: 20)
   */
  async search(query: string, start: string, end?: string, limit = 20): Promise<TempoResult> {
    if (!this.available) {
      return { available: false, reason: 'Tempo not configured (tempo.baseUrl is empty)' }
    }

    const params = new URLSearchParams({ q: query, limit: String(limit), start })
    if (end) params.set('end', end)

    const url = `${this.settings.baseUrl}/api/search?${params}`
    const res = await fetch(url, { headers: this.headers() })

    if (!res.ok) {
      const text = await res.text()
      return { available: false, reason: `Tempo search failed (${res.status}): ${text}` }
    }

    const body = await res.json() as { traces?: TempoTrace[] }
    return { available: true, traces: body.traces ?? [] }
  }

  /**
   * Search for traces by service name and optional status.
   * Convenience wrapper around `search()` for the common case.
   */
  async searchByService(
    serviceName: string,
    options: { errorOnly?: boolean; start?: string; end?: string; limit?: number } = {},
  ): Promise<TempoResult> {
    const conditions = [`.service.name = "${serviceName}"`]
    if (options.errorOnly) conditions.push('status = error')

    const query = `{ ${conditions.join(' && ')} }`
    return this.search(
      query,
      options.start ?? 'now-1h',
      options.end,
      options.limit ?? 20,
    )
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.settings.apiKey) {
      headers['Authorization'] = `Bearer ${this.settings.apiKey}`
    }
    return headers
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createTempoClient(settings: Settings): TempoClient {
  return new TempoClient(settings.tempo)
}
