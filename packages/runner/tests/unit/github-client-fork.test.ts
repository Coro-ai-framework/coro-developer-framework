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

interface RepoFacts {
  fork?: boolean
  parent?: string
  /** Former path of a moved repository: `fetch` follows GitHub's redirect. */
  redirectTo?: string
}

function repo(fullName: string, facts: RepoFacts = {}) {
  const fork = facts.fork ?? true
  const resolved = facts.redirectTo ?? fullName
  return {
    full_name: resolved,
    default_branch: 'main',
    clone_url: `https://github.com/${resolved}.git`,
    html_url: `https://github.com/${resolved}`,
    fork,
    ...(fork ? { parent: { full_name: facts.parent ?? UPSTREAM } } : {}),
  }
}

interface Recorded {
  paths: string[]
  forkBodies: unknown[]
}

/**
 * `accounts` maps a login to what `GET /users/<login>` answers with;
 * anything absent 404s. `repos` seeds repositories that already exist —
 * the short-circuit path, and the one place a name collision shows up.
 */
function mockFetch(opts: {
  accounts?: Record<string, { type: string }>
  repos?: Record<string, RepoFacts>
  self?: string | null
} = {}): Recorded {
  const accounts = opts.accounts ?? {}
  const existing = new Map<string, RepoFacts>(Object.entries(opts.repos ?? {}))
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
      // Nothing appears where another repository already claims the path.
      if (!existing.has(created)) existing.set(created, { fork: true })
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
    if (slug === UPSTREAM) return reply(200, repo(UPSTREAM, { fork: false }))
    const facts = existing.get(slug)
    if (facts) return reply(200, repo(slug, facts))
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
    const rec = mockFetch({ repos: { [`${SELF}/coro`]: { fork: true } } })

    const fork = await client().ensureFork(UPSTREAM, SELF, fast)

    expect(fork.full_name).toBe(`${SELF}/coro`)
    expect(rec.forkBodies).toEqual([])
    expect(rec.paths).toEqual([`/repos/${SELF}/coro`])
  })

  // A same-named repository that is not a fork would otherwise be adopted as
  // one: contribution branches pushed into it, and a PR GitHub cannot open.
  it('refuses a same-named repository that is not a fork', async () => {
    mockFetch({ repos: { [`${SELF}/coro`]: { fork: false } } })

    await expect(client().ensureFork(UPSTREAM, SELF, fast))
      .rejects.toThrow(/already exists and is not a fork of coro-ai-framework\/coro/)
  })

  // The upstream maintainer's own install: upstream was transferred out of
  // their account, so `GET /repos/<them>/<repo>` still redirects to upstream.
  // Adopting that as the fork would push contribution branches into upstream.
  it('refuses an address that only redirects to the repository that moved', async () => {
    const rec = mockFetch({
      accounts: { [SELF]: { type: 'User' } },
      repos: { [`${SELF}/coro`]: { fork: false, redirectTo: UPSTREAM } },
    })

    await expect(client().ensureFork(UPSTREAM, SELF, fast))
      .rejects.toThrow(/former path of coro-ai-framework\/coro and still redirects there/)

    // The fork was still attempted: a redirect is only terminal once GitHub
    // has declined to put a fork behind it.
    expect(rec.forkBodies).toEqual([{}])
  })

  it('refuses a same-named fork of some other repository', async () => {
    mockFetch({ repos: { [`${SELF}/coro`]: { fork: true, parent: 'someone-else/coro' } } })

    await expect(client().ensureFork(UPSTREAM, SELF, fast))
      .rejects.toThrow(/it is a fork of someone-else\/coro/)
  })
})
