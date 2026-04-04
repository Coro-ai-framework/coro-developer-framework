import { Settings } from '../config/settings'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LokiQueryResult {
  available: true
  lines: LokiLogLine[]
  stats: { totalBytesProcessed: number; execTime: number }
}

export interface LokiUnavailableResult {
  available: false
  reason: string
}

export type LokiResult = LokiQueryResult | LokiUnavailableResult

export interface LokiLogLine {
  timestamp: string  // nanosecond Unix timestamp as string
  line: string
  labels: Record<string, string>
}

// ── Client ────────────────────────────────────────────────────────────────────

/**
 * Loki HTTP API client.
 *
 * Returns `{ available: false }` if Loki is not configured (baseUrl empty).
 * This allows the agent to gracefully skip observability queries in local dev
 * without any code changes.
 */
export class LokiClient {
  private readonly available: boolean

  constructor(private readonly settings: { baseUrl: string; apiKey: string; username: string }) {
    this.available = settings.baseUrl.length > 0
  }

  /**
   * Execute a LogQL query over a time range.
   *
   * @param logQL   LogQL query string, e.g. `{service="my-service"} |= "error"`
   * @param start   Start time as Unix nanoseconds string or ISO-8601 (e.g. "now-1h")
   * @param end     End time (default: "now")
   * @param limit   Max log lines to return (default: 500)
   */
  async query(logQL: string, start: string, end = 'now', limit = 500): Promise<LokiResult> {
    if (!this.available) {
      return { available: false, reason: 'Loki not configured (loki.baseUrl is empty)' }
    }

    const params = new URLSearchParams({
      query: logQL,
      start,
      end,
      limit: String(limit),
      direction: 'backward',
    })

    const url = `${this.settings.baseUrl}/loki/api/v1/query_range?${params}`
    const res = await fetch(url, { headers: this.headers() })

    if (!res.ok) {
      const text = await res.text()
      return { available: false, reason: `Loki query failed (${res.status}): ${text}` }
    }

    const body = await res.json() as LokiApiResponse
    const lines = extractLines(body)
    const stats = body.data?.stats?.summary ?? { bytesProcessedPerSecond: 0, execTime: 0 }

    return {
      available: true,
      lines,
      stats: {
        totalBytesProcessed: stats.bytesProcessedPerSecond ?? 0,
        execTime: stats.execTime ?? 0,
      },
    }
  }

  /**
   * List all label values for a given label key.
   * Useful for discovering service names, environments, etc.
   */
  async labelValues(label: string): Promise<string[] | LokiUnavailableResult> {
    if (!this.available) {
      return { available: false, reason: 'Loki not configured (loki.baseUrl is empty)' }
    }

    const url = `${this.settings.baseUrl}/loki/api/v1/label/${encodeURIComponent(label)}/values`
    const res = await fetch(url, { headers: this.headers() })

    if (!res.ok) {
      return []
    }

    const body = await res.json() as { data: string[] }
    return body.data ?? []
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' }

    if (this.settings.username && this.settings.apiKey) {
      // Grafana Cloud uses Basic auth (username:apiKey)
      const encoded = Buffer.from(`${this.settings.username}:${this.settings.apiKey}`).toString('base64')
      headers['Authorization'] = `Basic ${encoded}`
    } else if (this.settings.apiKey) {
      headers['Authorization'] = `Bearer ${this.settings.apiKey}`
    }

    return headers
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createLokiClient(settings: Settings): LokiClient {
  return new LokiClient(settings.loki)
}

// ── Internal types / helpers ──────────────────────────────────────────────────

interface LokiApiResponse {
  status: string
  data?: {
    result?: { stream: Record<string, string>; values: [string, string][] }[]
    stats?: {
      summary?: { bytesProcessedPerSecond: number; execTime: number }
    }
  }
}

function extractLines(body: LokiApiResponse): LokiLogLine[] {
  const lines: LokiLogLine[] = []
  for (const stream of body.data?.result ?? []) {
    for (const [ts, line] of stream.values) {
      lines.push({ timestamp: ts, line, labels: stream.stream })
    }
  }
  // Sort ascending by timestamp
  return lines.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}
