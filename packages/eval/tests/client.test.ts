import { describe, expect, it } from 'vitest'
import { CoroApiError, CoroClient, isNeedsHumanStatus, isStoppedStatus, SseParser } from '../src/coro-client'

describe('SseParser', () => {
  it('reads a data frame', () => {
    expect(new SseParser().push('data: hello\n\n')).toEqual([{ data: 'hello' }])
  })

  it('reads a named event', () => {
    expect(new SseParser().push('event: done\ndata: complete\n\n')).toEqual([{ event: 'done', data: 'complete' }])
  })

  it('reads several frames in one chunk', () => {
    expect(new SseParser().push('data: a\n\ndata: b\n\nevent: done\ndata: ok\n\n').map(e => e.data)).toEqual(['a', 'b', 'ok'])
  })

  it('buffers a frame that is split across chunks, at any point', () => {
    const wire = 'data: first line\n\nevent: done\ndata: complete\n\n'
    for (let cut = 1; cut < wire.length; cut++) {
      const parser = new SseParser()
      const events = [...parser.push(wire.slice(0, cut)), ...parser.push(wire.slice(cut))]
      expect(events, `cut at ${cut}`).toEqual([{ data: 'first line' }, { event: 'done', data: 'complete' }])
    }
  })

  it('joins multi-line data with a newline', () => {
    expect(new SseParser().push('data: one\ndata: two\n\n')).toEqual([{ data: 'one\ntwo' }])
  })

  it('accepts CRLF line endings', () => {
    expect(new SseParser().push('data: x\r\n\r\n')).toEqual([{ data: 'x' }])
  })

  it('ignores comments and strips one leading space only', () => {
    expect(new SseParser().push(': keep-alive\n\ndata:  two spaces\n\n')).toEqual([{ data: ' two spaces' }])
  })

  it('emits nothing for an incomplete frame', () => {
    expect(new SseParser().push('data: unfinished')).toEqual([])
  })
})

describe('status helpers', () => {
  it('knows which statuses are final', () => {
    for (const status of ['complete', 'failed', 'escalated', 'cancelled']) expect(isStoppedStatus(status), status).toBe(true)
    for (const status of ['coding', 'planning', 'awaiting-pr-merge', 'awaiting-developer-input']) expect(isStoppedStatus(status), status).toBe(false)
  })

  it('knows which parks need a person, and that a pull-request park does not', () => {
    expect(isNeedsHumanStatus('awaiting-developer-input')).toBe(true)
    expect(isNeedsHumanStatus('awaiting-plan-approval')).toBe(true)
    expect(isNeedsHumanStatus('awaiting-pr-merge')).toBe(false)
    expect(isNeedsHumanStatus('coding')).toBe(false)
  })
})

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) })
    return handler(String(url), init)
  }) as typeof fetch
  return { fn, calls }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('CoroClient', () => {
  it('dispatches with a JSON body and returns the job id', async () => {
    const { fn, calls } = fakeFetch(() => json({ jobId: 'job-1', type: 'job', status: 'queued', streamUrl: '/jobs/job-1/stream' }))
    const client = new CoroClient('http://x', fn)
    const response = await client.dispatch({ workflowPath: 'w.md', type: 'job', repo: '/repo', description: 'do it' })
    expect(response.jobId).toBe('job-1')
    expect(calls[0]!.url).toBe('http://x/jobs')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ workflowPath: 'w.md', type: 'job', repo: '/repo', description: 'do it' })
  })

  it('fetches a job, encoding the id', async () => {
    const { fn, calls } = fakeFetch(() => json({ id: 'a/b', status: 'coding' }))
    const job = await new CoroClient('http://x', fn).getJob('a/b')
    expect(job.status).toBe('coding')
    expect(calls[0]!.url).toBe('http://x/jobs/a%2Fb')
  })

  it('cancels with a POST', async () => {
    const { fn, calls } = fakeFetch(() => json({}))
    await new CoroClient('http://x', fn).cancel('job-1')
    expect(calls[0]!.url).toBe('http://x/jobs/job-1/cancel')
    expect(calls[0]!.init?.method).toBe('POST')
  })

  it('turns an HTTP error into a CoroApiError that carries the status and the start of the body', async () => {
    const { fn } = fakeFetch(() => new Response('workflow not found', { status: 400 }))
    const error = await new CoroClient('http://x', fn).dispatch({ workflowPath: 'w', type: 'job', repo: '/r', description: 'd' }).catch(e => e)
    expect(error).toBeInstanceOf(CoroApiError)
    expect(error.status).toBe(400)
    expect(error.message).toContain('workflow not found')
  })

  it('reports health as a boolean and never throws', async () => {
    expect(await new CoroClient('http://x', fakeFetch(() => json({ ok: true })).fn).health()).toBe(true)
    expect(await new CoroClient('http://x', fakeFetch(() => new Response('', { status: 503 })).fn).health()).toBe(false)
    expect(
      await new CoroClient('http://x', (async () => {
        throw new Error('refused')
      }) as typeof fetch).health(),
    ).toBe(false)
  })

  describe('streamLog', () => {
    const stream = (chunks: string[]): Response =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
            controller.close()
          },
        }),
      )

    it('hands over each log line and stops at the done event', async () => {
      const { fn } = fakeFetch(() => stream(['data: one\n\ndata: tw', 'o\n\nevent: done\ndata: complete\n\ndata: ignored\n\n']))
      const lines: string[] = []
      await new CoroClient('http://x', fn).streamLog('job-1', line => lines.push(line), new AbortController().signal)
      expect(lines).toEqual(['one', 'two'])
    })

    it('resolves instead of throwing when the connection fails', async () => {
      const fn = (async () => {
        throw new Error('reset')
      }) as typeof fetch
      await expect(new CoroClient('http://x', fn).streamLog('job-1', () => undefined, new AbortController().signal)).resolves.toBeUndefined()
    })

    it('resolves when the server answers with an error', async () => {
      const { fn } = fakeFetch(() => new Response('no', { status: 500 }))
      await expect(new CoroClient('http://x', fn).streamLog('job-1', () => undefined, new AbortController().signal)).resolves.toBeUndefined()
    })
  })
})
