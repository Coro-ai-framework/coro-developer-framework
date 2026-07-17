// Tests for native threaded (nested) tracker comments: reading `parentId`
// off replies and posting a reply by passing `parentId`. Covers the two
// providers with a threaded comment model — Jira (REST) and Linear
// (GraphQL). GitHub Issues is flat and intentionally excluded.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { JiraTrackerClient } from '../../src/clients/tracker/jira'
import { LinearTrackerClient } from '../../src/clients/tracker/linear'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

describe('Jira threaded comments', () => {
  const client = new JiraTrackerClient({
    baseUrl: 'https://example.atlassian.net',
    username: 'bot@example.com',
    apiToken: 'token',
  })

  it('maps parentId off replies and leaves top-level comments without one', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        comments: [
          { id: '100', body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'root' }] }] }, created: '2026-01-01T00:00:00.000Z' },
          { id: '101', parentId: '100', body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'reply' }] }] }, created: '2026-01-01T01:00:00.000Z' },
        ],
      }),
    ) as unknown as typeof fetch

    const result = await client.getComments('ENG-1')
    expect(Array.isArray(result)).toBe(true)
    const comments = result as Array<{ id: string; parentId?: string }>
    expect(comments[0]).toMatchObject({ id: '100' })
    expect(comments[0].parentId).toBeUndefined()
    expect(comments[1]).toMatchObject({ id: '101', parentId: '100' })
  })

  it('sends parentId as a top-level sibling of body when replying', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: '200' }, true, 201))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await client.commentIssue({ key: 'ENG-1', body: 'a reply', parentId: '100' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const payload = JSON.parse(String(init.body))
    expect(payload.parentId).toBe('100')
    expect(payload.body.type).toBe('doc')
  })

  it('omits parentId for a top-level comment', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: '201' }, true, 201))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await client.commentIssue({ key: 'ENG-1', body: 'top level' })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const payload = JSON.parse(String(init.body))
    expect('parentId' in payload).toBe(false)
  })
})

describe('Linear threaded comments', () => {
  const client = new LinearTrackerClient({ apiKey: 'lin_key' })

  it('maps parent.id to parentId on replies', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        data: {
          issue: {
            comments: {
              nodes: [
                { id: 'c1', body: 'root', createdAt: '2026-01-01T00:00:00.000Z' },
                { id: 'c2', body: 'reply', createdAt: '2026-01-01T01:00:00.000Z', parent: { id: 'c1' } },
              ],
            },
          },
        },
      }),
    ) as unknown as typeof fetch

    const result = await client.getComments('ENG-1')
    const comments = result as Array<{ id: string; parentId?: string }>
    expect(comments[0].parentId).toBeUndefined()
    expect(comments[1]).toMatchObject({ id: 'c2', parentId: 'c1' })
  })

  it('passes parentId into the commentCreate input', async () => {
    const bodies: Array<Record<string, unknown>> = []
    globalThis.fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      const parsed = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> }
      bodies.push(parsed)
      if (parsed.query.includes('issue(id:')) {
        return jsonResponse({ data: { issue: { id: 'uuid-1', identifier: 'ENG-1', title: 't', url: 'u' } } })
      }
      return jsonResponse({ data: { commentCreate: { success: true } } })
    }) as unknown as typeof fetch

    await client.commentIssue({ key: 'ENG-1', body: 'a reply', parentId: 'c1' })

    const createCall = bodies.find(b => String(b.query).includes('commentCreate'))
    expect(createCall).toBeDefined()
    const input = (createCall!.variables as { input: Record<string, unknown> }).input
    expect(input).toMatchObject({ issueId: 'uuid-1', body: 'a reply', parentId: 'c1' })
  })
})
