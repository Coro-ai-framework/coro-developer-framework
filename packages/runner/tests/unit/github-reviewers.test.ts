// GitHub reviewer requests.
//
// scm_add_pr_reviewers and scm_resolve_user only run when the SCM plugin
// implements addReviewers / resolveUser. The GitHub plugin left both
// undefined, so the proxy returned "does not support adding reviewers"
// and the PR reviewer tagged people in a comment instead of requesting
// a review. These tests pin the REST call and the name → login lookup.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import pino from 'pino'
import { GitHubClient } from '../../src/clients/github'
import { createGitHubScmPlugin } from '../../src/plugins/builtin/github'
import type { ScmPluginRuntime } from '../../src/plugins/types'

const OWNER = 'acme'
const REPO = 'acme/widgets'

const OCTOCAT = {
  login: 'octocat',
  id: 1,
  node_id: 'MDQ6VXNlcjE=',
  name: 'The Octocat',
  type: 'User',
}

const JANE = {
  login: 'jane',
  id: 2,
  node_id: 'U_kgDOJane',
  name: 'Jane Doe',
  type: 'User',
}

interface Call {
  method: string
  url: string
  body?: unknown
}

function installFetch(
  handler: (call: Call) => { status?: number; body: unknown },
): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(url),
      ...(init?.body ? { body: JSON.parse(init.body) as unknown } : {}),
    }
    calls.push(call)
    const result = handler(call)
    const status = result.status ?? 200
    const text = typeof result.body === 'string' ? result.body : JSON.stringify(result.body)
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (typeof result.body === 'string' ? JSON.parse(result.body) : result.body),
      text: async () => text,
      headers: new Headers(),
    } as unknown as Response
  }))
  return calls
}

function client(): GitHubClient {
  return new GitHubClient(OWNER, 'test-token')
}

function userByLogin(login: string): typeof OCTOCAT | undefined {
  if (login.toLowerCase() === 'octocat') return OCTOCAT
  if (login.toLowerCase() === 'jane') return JANE
  return undefined
}

describe('GitHubClient reviewers', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('requests a review by login without searching', async () => {
    const calls = installFetch(call => {
      const login = call.url.match(/\/users\/([^/?]+)$/)?.[1]
      const user = login ? userByLogin(decodeURIComponent(login)) : undefined
      if (user) return { body: user }
      if (call.url.includes('/requested_reviewers')) return { body: {} }
      return { status: 404, body: 'not found' }
    })

    await client().requestReviewers(REPO, 12, ['@OctoCat'])

    const review = calls.find(c => c.url.includes('/requested_reviewers'))
    expect(review).toMatchObject({
      method: 'POST',
      body: { reviewers: ['octocat'] },
    })
    expect(review?.url).toContain('/repos/acme/widgets/pulls/12/requested_reviewers')
    expect(calls.some(c => c.url.includes('/graphql'))).toBe(false)
    expect(calls.some(c => c.url.includes('/search/users'))).toBe(false)
  })

  it('resolves an organisation display name to a login before requesting', async () => {
    const calls = installFetch(call => {
      if (call.url.endsWith('/graphql')) {
        return {
          body: {
            data: {
              organization: {
                membersWithRole: {
                  nodes: [{ login: 'jane', name: 'Jane Doe', id: 'U_kgDOJane', databaseId: 2 }],
                },
              },
            },
          },
        }
      }
      if (call.url.includes('/requested_reviewers')) return { body: {} }
      return { status: 404, body: 'not found' }
    })

    await client().requestReviewers(REPO, 12, ['Jane Doe'])

    const review = calls.find(c => c.url.includes('/requested_reviewers'))
    expect(review?.body).toEqual({ reviewers: ['jane'] })
    expect(calls.some(c => c.url.includes('/search/users'))).toBe(false)
  })

  it('does not request a review when the name matches nobody', async () => {
    const calls = installFetch(call => {
      if (call.url.endsWith('/graphql')) {
        return { body: { data: { organization: { membersWithRole: { nodes: [] } } } } }
      }
      if (call.url.includes('/search/users')) return { body: { items: [] } }
      return { status: 404, body: 'not found' }
    })

    await expect(client().requestReviewers(REPO, 12, ['Nobody Known'])).rejects.toThrow(/could not resolve/)
    expect(calls.some(c => c.url.includes('/requested_reviewers'))).toBe(false)
  })

  it('refuses to guess when several organisation members partially match', async () => {
    installFetch(call => {
      if (call.url.endsWith('/graphql')) {
        return {
          body: {
            data: {
              organization: {
                membersWithRole: {
                  nodes: [
                    { login: 'jane', name: 'Jane Doe', id: 'U_kgDOJane', databaseId: 2 },
                    { login: 'janet', name: 'Janet Doe', id: 'U_kgDOJanet', databaseId: 3 },
                  ],
                },
              },
            },
          },
        }
      }
      return { status: 404, body: 'not found' }
    })

    await expect(client().resolveUser('Doe')).resolves.toBeNull()
  })

  it('accepts an exact public display name when the organisation has no match', async () => {
    installFetch(call => {
      if (call.url.endsWith('/graphql')) {
        return { body: { data: { organization: null } } }
      }
      if (call.url.includes('/search/users')) {
        const q = new URL(call.url).searchParams.get('q') ?? ''
        if (q.includes('org:')) return { body: { items: [] } }
        return { body: { items: [{ login: 'jane' }] } }
      }
      const login = call.url.match(/\/users\/([^/?]+)$/)?.[1]
      const user = login ? userByLogin(decodeURIComponent(login)) : undefined
      if (user) return { body: user }
      return { status: 404, body: 'not found' }
    })

    await expect(client().resolveUser('Jane Doe')).resolves.toMatchObject({
      nickname: 'jane',
      display_name: 'Jane Doe',
    })
  })

  it('does not attach a public profile whose name only partially matches', async () => {
    installFetch(call => {
      if (call.url.endsWith('/graphql')) {
        return { body: { data: { organization: null } } }
      }
      if (call.url.includes('/search/users')) {
        const q = new URL(call.url).searchParams.get('q') ?? ''
        if (q.includes('org:')) return { body: { items: [] } }
        return { body: { items: [{ login: 'octocat' }] } }
      }
      const login = call.url.match(/\/users\/([^/?]+)$/)?.[1]
      const user = login ? userByLogin(decodeURIComponent(login)) : undefined
      if (user) return { body: user }
      return { status: 404, body: 'not found' }
    })

    await expect(client().resolveUser('Jane Doe')).resolves.toBeNull()
  })

  it('surfaces a collaborator rejection from GitHub', async () => {
    installFetch(call => {
      const login = call.url.match(/\/users\/([^/?]+)$/)?.[1]
      const user = login ? userByLogin(decodeURIComponent(login)) : undefined
      if (user) return { body: user }
      if (call.url.includes('/requested_reviewers')) {
        return { status: 422, body: 'Reviews may only be requested from collaborators' }
      }
      return { status: 404, body: 'not found' }
    })

    await expect(client().requestReviewers(REPO, 12, ['octocat'])).rejects.toThrow(/collaborators/)
  })

  it('resolves a node id through GraphQL', async () => {
    installFetch(call => {
      if (call.url.endsWith('/graphql')) {
        return {
          body: {
            data: { node: { login: 'octocat', name: 'The Octocat', id: OCTOCAT.node_id, databaseId: 1 } },
          },
        }
      }
      return { status: 404, body: 'not found' }
    })

    await expect(client().resolveUser(OCTOCAT.node_id)).resolves.toMatchObject({ nickname: 'octocat' })
  })
})

describe('GitHub plugin reviewers', () => {
  const logger = pino({ level: 'silent' })

  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  async function plugin(): Promise<ScmPluginRuntime> {
    const created = createGitHubScmPlugin({ config: { owner: OWNER, token: 'test-token' }, logger })
    await created.init({ owner: OWNER, token: 'test-token' }, { logger } as never)
    return created
  }

  it('addReviewers posts the resolved login', async () => {
    const calls = installFetch(call => {
      const login = call.url.match(/\/users\/([^/?]+)$/)?.[1]
      const user = login ? userByLogin(decodeURIComponent(login)) : undefined
      if (user) return { body: user }
      if (call.url.includes('/requested_reviewers')) return { body: {} }
      return { status: 404, body: 'not found' }
    })

    const scm = await plugin()
    await scm.addReviewers!({ repoSlug: REPO, prId: 12, reviewers: ['octocat'] })

    expect(calls.some(c =>
      c.method === 'POST' && c.url.includes('/repos/acme/widgets/pulls/12/requested_reviewers'),
    )).toBe(true)
  })

  it('resolveUser returns the login the reviewer request needs', async () => {
    installFetch(call => {
      const login = call.url.match(/\/users\/([^/?]+)$/)?.[1]
      const user = login ? userByLogin(decodeURIComponent(login)) : undefined
      if (user) return { body: user }
      return { status: 404, body: 'not found' }
    })

    const scm = await plugin()
    await expect(scm.resolveUser!('octocat')).resolves.toMatchObject({
      nickname: 'octocat',
      uuid: OCTOCAT.node_id,
    })
  })

  it('rejects a non-numeric pull request id before calling GitHub', async () => {
    const calls = installFetch(() => ({ body: {} }))
    const scm = await plugin()
    await expect(scm.addReviewers!({ repoSlug: REPO, prId: 'abc', reviewers: ['octocat'] }))
      .rejects.toThrow(/numeric/)
    expect(calls).toHaveLength(0)
  })
})
