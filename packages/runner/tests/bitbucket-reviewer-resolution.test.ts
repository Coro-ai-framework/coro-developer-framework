import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BitBucketClient, bbReviewerEntry } from '../src/clients/bitbucket'

describe('bbReviewerEntry', () => {
  it('maps braced uuid → uuid field', () => {
    expect(bbReviewerEntry('{12345678-1234-1234-1234-123456789abc}'))
      .toEqual({ uuid: '{12345678-1234-1234-1234-123456789abc}' })
  })
  it('braces bare uuid', () => {
    expect(bbReviewerEntry('12345678-1234-1234-1234-123456789abc'))
      .toEqual({ uuid: '{12345678-1234-1234-1234-123456789abc}' })
  })
  it('maps modern account_id → account_id field', () => {
    expect(bbReviewerEntry('557058:abc-def')).toEqual({ account_id: '557058:abc-def' })
  })
  it('treats other strings as username', () => {
    expect(bbReviewerEntry('samir.benali')).toEqual({ username: 'samir.benali' })
  })
})

describe('BitBucketClient reviewer resolution', () => {
  const realFetch = globalThis.fetch
  let calls: { url: string; init?: RequestInit }[]
  beforeEach(() => {
    calls = []
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      calls.push({ url: u, init })
      const body = handler(u, init)
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response
    }) as typeof fetch
  }

  it('returns uuids as-is without hitting workspace members', async () => {
    mockFetch(() => ({ values: [], next: undefined }))
    const c = new BitBucketClient('myws', 'user', 'pw')
    const out = await c.resolveReviewerIdentifier('{abcdef12-1234-1234-1234-abcdef123456}')
    expect(out).toBe('{abcdef12-1234-1234-1234-abcdef123456}')
    expect(calls.length).toBe(0)
  })

  it('returns account_ids as-is', async () => {
    mockFetch(() => ({ values: [], next: undefined }))
    const c = new BitBucketClient('myws', 'user', 'pw')
    expect(await c.resolveReviewerIdentifier('557058:abc-def')).toBe('557058:abc-def')
    expect(calls.length).toBe(0)
  })

  it('resolves nickname → uuid via /workspaces/{ws}/members', async () => {
    mockFetch(url => {
      if (url.includes('/workspaces/myws/members')) {
        return {
          values: [
            { user: { uuid: '{u1}', nickname: 'samir.benali', display_name: 'Samir Benali', account_id: '557058:a' } },
            { user: { uuid: '{u2}', nickname: 'jane.doe', display_name: 'Jane Doe', account_id: '557058:b' } },
          ],
          next: undefined,
        }
      }
      return {}
    })
    const c = new BitBucketClient('myws', 'user', 'pw')
    expect(await c.resolveReviewerIdentifier('samir.benali')).toBe('{u1}')
    // second call uses cache, no additional fetch
    const before = calls.length
    expect(await c.resolveReviewerIdentifier('Jane Doe')).toBe('{u2}')
    expect(calls.length).toBe(before)
  })

  it('throws a helpful error when nickname is not found', async () => {
    mockFetch(() => ({ values: [], next: undefined }))
    const c = new BitBucketClient('myws', 'user', 'pw')
    await expect(c.resolveReviewerIdentifier('nobody.here'))
      .rejects.toThrow(/no Bitbucket workspace member matches "nobody.here"/)
  })
})
