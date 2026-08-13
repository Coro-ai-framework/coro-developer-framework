// Fork creation for the GitHub REST client.
//
// Regression origin: a retrospective could file its issues but neither of its
// fork-dependent steps could finish — every attempt came back
// `422 Fork organization invalid`. `ensureFork` sent `{ organization:
// forkOwner }` whenever a fork owner was given, and the upstream tools always
// give one. GitHub accepts that parameter only for an organisation, so the
// configuration the dashboard asks for ("Fork owner: your-github-username")
// was guaranteed to fail.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GitHubClient } from '../../src/clients/github'

const UPSTREAM = 'coro-ai-framework/coro'
const SELF = 'contributor'

function repo(fullName: string) {
  return {
    full_name: fullName,
    default_branch: 'main',
    clone_url: `https://github.com/${fullName}.git`,
    html_url: `https://github.com/${fullName}`,
    fork: fullName !== UPSTREAM,
  }
}

interface Recorded {
  paths: string[]
  forkBodies: unknown[]
}

/**
 * `accounts` maps a login to what `GET /users/<login>` answers with;
 * anything absent 404s. `existingForks` decides whether the fork is already
 * there, which is the short-circuit path.
 */
function mockFetch(opts: {
  accounts?: Record<string, { type: string }>
  existingForks?: string[]
  self?: string | null
} = {}): Recorded {
  const accounts = opts.accounts ?? {}
  const existing = new Set(opts.existingForks ?? [])
  const self = opts.self === undefined ? SELF : opts.self
  const recorded: Recorded = { paths: [], forkBodies: [] }

  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const path = new URL(String(url)).pathname
    const method = init?.method ?? 'GET'
    recorded.paths.push(path)

    const reply = (status: number, body: unknown) => ({
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: new Headers(),
    }) as unknown as Response

    if (method === 'POST' && path.endsWith('/forks')) {
      const body = JSON.parse(init?.body ?? '{}') as { organization?: string }
      recorded.forkBodies.push(body)
      // GitHub answers 202 with the fork record before it is clonable, and
      // the fork lands under `organization` when present, the token owner's
      // account when not.
      const created = `${body.organization ?? self ?? SELF}/coro`
      existing.add(created)
      return reply(202, repo(created))
    }

    if (path === '/user') {
      return self ? reply(200, { login: self }) : reply(401, { message: 'Bad credentials' })
    }

    if (path.startsWith('/users/')) {
      const login = decodeURIComponent(path.slice('/users/'.length))
      const account = accounts[login]
      return account ? reply(200, { login, ...account }) : reply(404, { message: 'Not Found' })
    }

    const slug = path.replace(/^\/repos\//, '')
    if (slug === UPSTREAM) return reply(200, repo(UPSTREAM))
    if (existing.has(slug)) return reply(200, repo(slug))
    return reply(404, { message: 'Not Found' })
  }))

  return recorded
}

function client(): GitHubClient {
  return new GitHubClient(SELF, 'test-token')
}

const fast = { attempts: 1, delayMs: 0 }

describe('GitHubClient.ensureFork', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  // The exact shape from the production failure.
  it('omits `organization` when forking into the token owner\'s own account', async () => {
    const rec = mockFetch({ accounts: { [SELF]: { type: 'User' } } })

    const fork = await client().ensureFork(UPSTREAM, SELF, fast)

    expect(fork.full_name).toBe(`${SELF}/coro`)
    expect(rec.forkBodies).toEqual([{}])
  })

  it('sends `organization` when the fork owner is an organisation', async () => {
    const rec = mockFetch({ accounts: { 'coro-forks': { type: 'Organization' } } })

    const fork = await client().ensureFork(UPSTREAM, 'coro-forks', fast)

    expect(fork.full_name).toBe('coro-forks/coro')
    expect(rec.forkBodies).toEqual([{ organization: 'coro-forks' }])
  })

  // Omitting `organization` here would fork into the token owner's account
  // instead, then poll a repository that is never going to appear.
  it('refuses a personal account that is not the token owner\'s', async () => {
    const rec = mockFetch({ accounts: { someone: { type: 'User' } } })

    await expect(client().ensureFork(UPSTREAM, 'someone', fast))
      .rejects.toThrow(/"someone".*personal account.*"contributor"/s)
    expect(rec.forkBodies).toEqual([])
  })

  it('names the setting when the fork owner does not exist', async () => {
    const rec = mockFetch()

    await expect(client().ensureFork(UPSTREAM, 'nope', fast))
      .rejects.toThrow(/No GitHub user or organisation named "nope".*upstream\.forkOwner/s)
    expect(rec.forkBodies).toEqual([])
  })

  // The login lookup guards a misconfiguration; it must not become a new way
  // for the ordinary case to fail.
  it('still forks into the own account when the login cannot be read', async () => {
    const rec = mockFetch({ accounts: { [SELF]: { type: 'User' } }, self: null })

    await client().ensureFork(UPSTREAM, SELF, fast)

    expect(rec.forkBodies).toEqual([{}])
  })

  it('short-circuits on an existing fork without classifying the account', async () => {
    const rec = mockFetch({ existingForks: [`${SELF}/coro`] })

    const fork = await client().ensureFork(UPSTREAM, SELF, fast)

    expect(fork.full_name).toBe(`${SELF}/coro`)
    expect(rec.forkBodies).toEqual([])
    expect(rec.paths).toEqual([`/repos/${SELF}/coro`])
  })
})
