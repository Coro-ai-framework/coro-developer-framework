import type { Job } from '@coro-ai/cloud-protocol'

/**
 * A thin wrapper over the runner's HTTP API. It knows four routes and nothing
 * else about Coro:
 *
 *   POST /jobs                 dispatch
 *   GET  /jobs/:id             the job record
 *   GET  /jobs/:id/stream      server-sent events: log lines, then `done`
 *   POST /jobs/:id/cancel      stop a job
 *
 * Status strings are plain strings on purpose: `Job.status` is a `string` in
 * the protocol (phase names appear in it too), and importing the constants
 * would be a runtime dependency on Coro.
 */

export const STATUS = {
  complete: 'complete',
  cancelled: 'cancelled',
  failed: 'failed',
  escalated: 'escalated',
  awaitingPrMerge: 'awaiting-pr-merge',
  awaitingDeveloperInput: 'awaiting-developer-input',
  awaitingPlanApproval: 'awaiting-plan-approval',
} as const

/** The job will not move again without a human or a new dispatch. */
export function isStoppedStatus(status: string): boolean {
  return (
    status === STATUS.complete ||
    status === STATUS.cancelled ||
    status === STATUS.failed ||
    status === STATUS.escalated
  )
}

/** Parked waiting for a person to answer or approve something. */
export function isNeedsHumanStatus(status: string): boolean {
  return status === STATUS.awaitingDeveloperInput || status === STATUS.awaitingPlanApproval
}

export interface DispatchRequest {
  workflowPath: string
  type: 'job'
  /** An absolute path to a git repository: the local SCM plugin's notion of a repo. */
  repo: string
  description: string
  params?: Record<string, unknown>
}

export interface DispatchResponse {
  jobId: string
  type: string
  status: string
  streamUrl: string
}

export class CoroApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = 'CoroApiError'
  }
}

export type FetchLike = typeof fetch

export class CoroClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  private async request(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<Response> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new CoroApiError(`${init?.method ?? 'GET'} ${path} -> ${response.status}: ${body.slice(0, 500)}`, response.status, body)
    }
    return response
  }

  async health(): Promise<boolean> {
    try {
      await this.request('/health', undefined, 5_000)
      return true
    } catch {
      return false
    }
  }

  async dispatch(request: DispatchRequest): Promise<DispatchResponse> {
    const response = await this.request('/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    return (await response.json()) as DispatchResponse
  }

  async getJob(jobId: string): Promise<Job> {
    const response = await this.request(`/jobs/${encodeURIComponent(jobId)}`)
    return (await response.json()) as Job
  }

  async cancel(jobId: string): Promise<void> {
    await this.request(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' })
  }

  /**
   * Follow the job's log until the server ends the stream (it sends a `done`
   * event once the job stops) or `signal` aborts. Each log line is passed to
   * `onLine`. Resolves rather than rejects when the connection drops, since
   * the log is a convenience and the poll loop is the source of truth.
   */
  async streamLog(jobId: string, onLine: (line: string) => void, signal: AbortSignal): Promise<void> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/jobs/${encodeURIComponent(jobId)}/stream`, { signal })
      if (!response.ok || !response.body) return
      const parser = new SseParser()
      const decoder = new TextDecoder()
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          if (event.event === 'done') return
          onLine(event.data)
        }
      }
    } catch {
      // aborted or dropped: the caller polls for the real state
    }
  }
}

// ── SSE parsing ──────────────────────────────────────────────────────────────

export interface SseEvent {
  /** Value of the `event:` field; undefined for plain data frames. */
  event?: string
  /** `data:` lines joined with a newline. */
  data: string
}

/**
 * Incremental server-sent-events parser. The runner frames each log line as
 * `data: <line>\n\n` and the final status as `event: done\ndata: <status>\n\n`.
 * Chunks may split a frame anywhere, so incomplete input is buffered.
 */
export class SseParser {
  private buffer = ''

  push(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n/g, '\n')
    const events: SseEvent[] = []
    for (;;) {
      const end = this.buffer.indexOf('\n\n')
      if (end < 0) break
      const frame = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 2)
      const event = parseFrame(frame)
      if (event) events.push(event)
    }
    return events
  }
}

function parseFrame(frame: string): SseEvent | undefined {
  let event: string | undefined
  const data: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  if (data.length === 0 && event === undefined) return undefined
  return { ...(event !== undefined ? { event } : {}), data: data.join('\n') }
}
