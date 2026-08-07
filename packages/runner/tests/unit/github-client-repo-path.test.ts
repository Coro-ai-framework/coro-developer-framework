// Repo addressing for the GitHub REST client.
//
// Regression origin: jobs are routinely started with `--repo owner/repo`, and
// that string is stored verbatim as the external ref's `repoKey`. The PR
// methods used to interpolate it straight after the configured owner, so a
// poll for `A5Labs-Prime/a5labs.dashboard-api-go` requested
// `/repos/A5Labs-Prime/A5Labs-Prime/a5labs.dashboard-api-go/...` and got a 404
// on every cycle. Three different normalisation conventions coexisted in the
// class at the time; these tests pin all methods to the same one.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GitHubClient } from '../../src/clients/github'

const OWNER = 'A5Labs-Prime'
const REPO = 'a5labs.dashboard-api-go'

const GH_PR = {
  id: 100,
  number: 5,
  title: 'A PR',
  body: '',
  state: 'open',
  merged: false,
  head: { ref: 'feat/x' },
  base: { ref: 'main' },
  user: { login: 'someone' },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  html_url: 'https://github.com/x/y/pull/5',
}

/**
 * Record every URL the client requests, replying with a shape the calling
 * method can actually parse. These tests are about the path, but the methods
 * still have to run to completion to produce every request they make.
 */
function mockFetch(): { urls: string[] } {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
    urls.push(String(url))
    const path = new URL(String(url)).pathname
    const method = init?.method ?? 'GET'
    const comment = { id: 1, body: 'hi', created_at: '', updated_at: '' }

    let body: unknown = GH_PR
    if (path.includes('/contents/')) body = { content: '', encoding: 'base64' }
    else if (method === 'GET' && /\/(reviews|comments)$/.test(path)) body = []
    else if (/\/(comments|replies)$/.test(path)) body = comment

    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: new Headers(),
    } as unknown as Response
  }))
  return { urls }
}

function client(): GitHubClient {
  return new GitHubClient(OWNER, 'test-token')
}

/** Path portion of every recorded request, minus the query string. */
function paths(urls: string[]): string[] {
  return urls.map(u => new URL(u).pathname)
}

describe('GitHubClient repo addressing', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  // The exact shape from the production failure.
  it('does not double the owner when the repo is given as owner/repo', async () => {
    const { urls } = mockFetch()
    await client().getComments(`${OWNER}/${REPO}`, 5)

    expect(paths(urls)).toEqual([
      `/repos/${OWNER}/${REPO}/issues/5/comments`,
      `/repos/${OWNER}/${REPO}/pulls/5/comments`,
    ])
    for (const p of paths(urls)) {
      expect(p).not.toContain(`${OWNER}/${OWNER}`)
    }
  })

  it('prefixes the configured owner when given a bare repo name', async () => {
    const { urls } = mockFetch()
    await client().getComments(REPO, 5)

    expect(paths(urls)[0]).toBe(`/repos/${OWNER}/${REPO}/issues/5/comments`)
  })

  it.each([
    ['bare repo', REPO, `${OWNER}/${REPO}`],
    ['owner/repo', `${OWNER}/${REPO}`, `${OWNER}/${REPO}`],
    ['https URL', `https://github.com/${OWNER}/${REPO}`, `${OWNER}/${REPO}`],
    ['https URL with .git', `https://github.com/${OWNER}/${REPO}.git`, `${OWNER}/${REPO}`],
    ['ssh remote', `git@github.com:${OWNER}/${REPO}.git`, `${OWNER}/${REPO}`],
    ['trailing slash', `${OWNER}/${REPO}/`, `${OWNER}/${REPO}`],
    ['deep PR URL', `https://github.com/${OWNER}/${REPO}/pull/5`, `${OWNER}/${REPO}`],
  ])('resolves %s to the same API path', async (_label, input, expected) => {
    const { urls } = mockFetch()
    await client().getPr(input, 5)

    expect(paths(urls)[0]).toBe(`/repos/${expected}/pulls/5`)
  })

  // An explicit owner must win. Stripping it (as the old `slug()` helper did)
  // silently retargeted cross-org repos at the configured org, which is worse
  // than a 404 because it can succeed against the wrong repository.
  it('honours an owner that differs from the configured one', async () => {
    const { urls } = mockFetch()
    await client().getComments('other-org/some-repo', 9)

    expect(paths(urls)[0]).toBe('/repos/other-org/some-repo/issues/9/comments')
  })

  // Every repo-addressing method, not just the one that surfaced the bug.
  describe('all PR methods normalise consistently', () => {
    const qualified = `${OWNER}/${REPO}`

    it('getPrStatus', async () => {
      const { urls } = mockFetch()
      await client().getPrStatus(qualified, 5)
      expect(paths(urls)).toEqual([
        `/repos/${qualified}/pulls/5`,
        `/repos/${qualified}/pulls/5/reviews`,
      ])
    })

    it('approvePr', async () => {
      const { urls } = mockFetch()
      await client().approvePr(qualified, 5)
      expect(paths(urls)[0]).toBe(`/repos/${qualified}/pulls/5/reviews`)
    })

    it('mergePr', async () => {
      const { urls } = mockFetch()
      await client().mergePr(qualified, 5)
      expect(paths(urls)[0]).toBe(`/repos/${qualified}/pulls/5/merge`)
    })

    it('createPr', async () => {
      const { urls } = mockFetch()
      await client().createPr({
        repoSlug: qualified,
        title: 't',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
      })
      expect(paths(urls)[0]).toBe(`/repos/${qualified}/pulls`)
    })

    it('postComment', async () => {
      const { urls } = mockFetch()
      await client().postComment(qualified, 5, 'hi')
      expect(paths(urls)[0]).toBe(`/repos/${qualified}/issues/5/comments`)
    })

    it('replyToComment', async () => {
      const { urls } = mockFetch()
      await client().replyToComment(qualified, 5, 1, 'hi')
      expect(paths(urls)[0]).toBe(`/repos/${qualified}/pulls/5/comments/1/replies`)
    })

    it('getFileContent', async () => {
      const { urls } = mockFetch()
      await client().getFileContent(qualified, 'go.mod', 'main')
      expect(paths(urls)[0]).toBe(`/repos/${qualified}/contents/go.mod`)
    })
  })
})
