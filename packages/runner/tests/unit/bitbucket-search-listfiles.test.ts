import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BitBucketClient } from '../../src/clients/bitbucket'

// ── BitBucketClient: searchCode + listFiles ──────────────────────────────────
//
// These two helpers feed plan-mode's `scm_search_code` and
// `scm_list_files` tools. The search-code response shape is non-obvious
// (content_matches → lines[] → segments[]) and the previous parser
// mishandled it, so every hit came back with empty snippets. listFiles
// is brand new in this refactor.

function makeJsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

describe('BitBucketClient.searchCode', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('assembles snippets from lines[].segments[].text', async () => {
    // Response shape from the official Atlassian docs:
    //   https://developer.atlassian.com/cloud/bitbucket/rest/api-group-other-operations/#api-workspaces-workspace-search-code-get
    fetchMock.mockResolvedValueOnce(makeJsonResponse({
      values: [
        {
          file: { path: 'src/Foo.cs' },
          content_matches: [
            {
              lines: [
                // padding line — must be skipped (empty segments)
                { line: 2, segments: [] },
                {
                  line: 3,
                  segments: [
                    { text: 'public class ' },
                    { text: 'Foo', match: true },
                    { text: ' {' },
                  ],
                },
                {
                  line: 4,
                  segments: [{ text: '    public int Bar() => 1;' }],
                },
              ],
            },
          ],
        },
      ],
    }))

    const client = new BitBucketClient('acme', 'user@example.com', 'tok')
    const hits = await client.searchCode('svc', 'Foo')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.path).toBe('src/Foo.cs')
    expect(hits[0]!.snippets).toEqual([
      { seq: 1, content: 'L3: public class Foo {' },
      { seq: 2, content: 'L4:     public int Bar() => 1;' },
    ])
    // No path_matches → no pathMatchOnly flag
    expect(hits[0]!.pathMatchOnly).toBeUndefined()
  })

  it('flags path-only matches when content_matches is empty but path_matches has a match', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({
      values: [
        {
          file: { path: 'src/A5Labs.BuyInBuyOut/A5Labs.BuyInBuyOut.csproj' },
          content_matches: [],
          path_matches: [
            { text: 'src/A5Labs.' },
            { text: 'BuyInBuyOut', match: true },
            { text: '/A5Labs.BuyInBuyOut.csproj' },
          ],
        },
      ],
    }))

    const client = new BitBucketClient('acme', 'user@example.com', 'tok')
    const hits = await client.searchCode('svc', 'BuyInBuyOut')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.path).toBe('src/A5Labs.BuyInBuyOut/A5Labs.BuyInBuyOut.csproj')
    expect(hits[0]!.snippets).toEqual([])
    expect(hits[0]!.pathMatchOnly).toBe(true)
  })

  it('returns an empty array when Bitbucket returns no values (free-tier / unindexed workspace)', async () => {
    // Bitbucket Cloud code search legitimately returns `200 { values: [] }`
    // for workspaces that aren't in the search index — the previous
    // parser also returned `[]` here so we lock that behaviour in.
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ values: [] }))
    const client = new BitBucketClient('acme', 'user@example.com', 'tok')
    expect(await client.searchCode('svc', 'anything')).toEqual([])
  })

  it('encodes the workspace/repo filter into search_query', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ values: [] }))
    const client = new BitBucketClient('acme', 'user@example.com', 'tok')
    await client.searchCode('svc', 'Foo')
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('/workspaces/acme/search/code')
    expect(url).toContain('search_query=repo%3Aacme%2Fsvc+Foo')
  })
})

describe('BitBucketClient.listFiles', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists the repo root when path is empty and translates commit_directory → dir', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({
      values: [
        { path: 'src', type: 'commit_directory' },
        { path: 'README.md', type: 'commit_file' },
        { path: '.gitignore', type: 'commit_file' },
      ],
    }))

    const client = new BitBucketClient('acme', 'user@example.com', 'tok')
    const entries = await client.listFiles('svc', '')
    expect(entries).toEqual([
      { path: 'src', type: 'dir' },
      { path: 'README.md', type: 'file' },
      { path: '.gitignore', type: 'file' },
    ])
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toBe('https://api.bitbucket.org/2.0/repositories/acme/svc/src/HEAD/')
  })

  it('strips leading/trailing slashes from path and uses the provided ref', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ values: [] }))
    const client = new BitBucketClient('acme', 'user@example.com', 'tok')
    await client.listFiles('svc', '/src/foo/', 'master')
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toBe('https://api.bitbucket.org/2.0/repositories/acme/svc/src/master/src/foo/')
  })

  it('paginates through next URLs up to the maxEntries cap', async () => {
    fetchMock
      .mockResolvedValueOnce(makeJsonResponse({
        values: [
          { path: 'a.txt', type: 'commit_file' },
          { path: 'b.txt', type: 'commit_file' },
        ],
        next: 'https://api.bitbucket.org/2.0/repositories/acme/svc/src/HEAD/?page=2',
      }))
      .mockResolvedValueOnce(makeJsonResponse({
        values: [
          { path: 'c.txt', type: 'commit_file' },
        ],
      }))

    const client = new BitBucketClient('acme', 'user@example.com', 'tok')
    const entries = await client.listFiles('svc', '', 'HEAD', 10)
    expect(entries.map(e => e.path)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops paginating once maxEntries is reached', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({
      values: [
        { path: 'a.txt', type: 'commit_file' },
        { path: 'b.txt', type: 'commit_file' },
        { path: 'c.txt', type: 'commit_file' },
      ],
      next: 'https://api.bitbucket.org/2.0/repositories/acme/svc/src/HEAD/?page=2',
    }))

    const client = new BitBucketClient('acme', 'user@example.com', 'tok')
    const entries = await client.listFiles('svc', '', 'HEAD', 2)
    expect(entries.map(e => e.path)).toEqual(['a.txt', 'b.txt'])
    // Cap honoured before exhausting the page, so no second request.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
