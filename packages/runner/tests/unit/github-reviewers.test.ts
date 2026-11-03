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

    await expect(client().requestReviewers(REPO, 12, ['Nobody Known'])).resolves.toEqual({
      requested: [],
      unresolved: ['Nobody Known'],
    })
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

// Enterprise Managed User installs: logins carry an `_<shortcode>`
// suffix, user search returns nobody, and `membersWithRole` has no
// `query` argument. Jobs passed "Samir Benali" / "lee.chun-chen" /
// "Scott Lee" and every PR opened without reviewers, silently.
describe('GitHubClient reviewers on an EMU organisation', () => {
  const COLLABORATORS = [
    { login: 'samir-benali_acme', name: 'Samir Benali', id: 'U_kgDOSamir', databaseId: 10 },
    { login: 'lee-chun-chen_acme', name: 'Lee Chun-Chen', id: 'U_kgDOLee', databaseId: 11 },
    { login: 'damien-lee_acme', name: 'Damien Lee', id: 'U_kgDODamien', databaseId: 12 },
    { login: 'chen-chun-hao_acme', name: 'Jacky Chen', id: 'U_kgDOJacky', databaseId: 13 },
  ]

  function emuFetch(): Call[] {
    return installFetch(call => {
      if (call.url.endsWith('/graphql')) {
        const query = (call.body as { query: string }).query
        if (query.includes('collaborators')) {
          return { body: { data: { repository: { collaborators: { nodes: COLLABORATORS } } } } }
        }
        return { body: { data: { organization: null } } }
      }
      if (call.url.includes('/search/users')) return { body: { items: [] } }
      if (call.url.includes('/requested_reviewers')) return { body: {} }
      const login = call.url.match(/\/users\/([^/?]+)$/)?.[1]
      const hit = COLLABORATORS.find(c => c.login === decodeURIComponent(login ?? ''))
      if (hit) return { body: { login: hit.login, id: hit.databaseId, node_id: hit.id, name: hit.name, type: 'User' } }
      return { status: 404, body: 'not found' }
    })
  }

  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('requests the names that resolve and reports the rest with candidates', async () => {
    const calls = emuFetch()

    const outcome = await client().requestReviewers(REPO, 66, ['samir benali', 'lee.chun-chen', 'Scott Lee'])

    expect(calls.find(c => c.url.includes('/requested_reviewers'))?.body).toEqual({
      reviewers: ['samir-benali_acme', 'lee-chun-chen_acme'],
    })
    expect(outcome.requested).toEqual(['samir-benali_acme', 'lee-chun-chen_acme'])
    expect(outcome.unresolved).toEqual(['Scott Lee'])
    expect(outcome.candidates).toContain('samir-benali_acme (Samir Benali)')
  })

  it.each([
    ['Samir Benali (samir-benali_acme)', 'samir-benali_acme'],
    ['samir-benali_acme', 'samir-benali_acme'],
    ['samir-benali', 'samir-benali_acme'],
    ['Benali Samir', 'samir-benali_acme'],
    ['samir', 'samir-benali_acme'],
    ['chen chun hao', 'chen-chun-hao_acme'],
    ['Jacky Chen', 'chen-chun-hao_acme'],
  ])('resolves %j to %s', async (input, login) => {
    emuFetch()
    await expect(client().resolveUser(input, { repoSlug: REPO })).resolves.toMatchObject({ nickname: login })
  })

  it('refuses a name that fits two collaborators', async () => {
    const calls = emuFetch()
    await expect(client().resolveUser('lee', { repoSlug: REPO })).resolves.toBeNull()
    // An ambiguous collaborator match must not fall through to a public /users/lee.
    expect(calls.some(c => c.url.endsWith('/users/lee'))).toBe(false)
  })

  it('looks an EMU login up as a login, not a node id', async () => {
    const calls = emuFetch()
    await expect(client().resolveUser('samir-benali_acme')).resolves.toMatchObject({ nickname: 'samir-benali_acme' })
    expect(calls.some(c => c.url.endsWith('/users/samir-benali_acme'))).toBe(true)
  })

  it('lists organisation members without the unsupported query argument', async () => {
    const calls = installFetch(call => {
      if (call.url.endsWith('/graphql')) {
        return {
          body: {
            data: {
              organization: {
                membersWithRole: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [COLLABORATORS[0]],
                },
              },
            },
          },
        }
      }
      return { status: 404, body: 'not found' }
    })

    await expect(client().resolveUser('Samir Benali')).resolves.toMatchObject({ nickname: 'samir-benali_acme' })
    const orgQuery = calls.find(c => c.url.endsWith('/graphql'))?.body as { query: string }
    expect(orgQuery.query).not.toMatch(/membersWithRole\(query/)
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

  it('createPr reports reviewers it could not request instead of dropping them', async () => {
    installFetch(call => {
      if (call.method === 'POST' && call.url.endsWith('/repos/acme/widgets/pulls')) {
        return {
          body: {
            number: 66,
            title: 't',
            body: '',
            state: 'open',
            merged: false,
            head: { ref: 'feature' },
            base: { ref: 'main' },
            user: { login: 'bot' },
            created_at: '',
            updated_at: '',
            html_url: 'https://github.com/acme/widgets/pull/66',
          },
        }
      }
      const login = call.url.match(/\/users\/([^/?]+)$/)?.[1]
      const user = login ? userByLogin(decodeURIComponent(login)) : undefined
      if (user) return { body: user }
      if (call.url.includes('/requested_reviewers')) return { body: {} }
      if (call.url.endsWith('/graphql')) return { body: { data: { organization: null } } }
      if (call.url.includes('/search/users')) return { body: { items: [] } }
      return { status: 404, body: 'not found' }
    })

    const scm = await plugin()
    const ref = await scm.createPr!({
      repoSlug: REPO,
      title: 't',
      sourceBranch: 'feature',
      reviewers: ['octocat', 'Nobody Known'],
    })

    expect(ref.externalId).toBe('66')
    expect(ref.reviewers).toEqual({ requested: ['octocat'], unresolved: ['Nobody Known'] })
  })

  it('rejects a non-numeric pull request id before calling GitHub', async () => {
    const calls = installFetch(() => ({ body: {} }))
    const scm = await plugin()
    await expect(scm.addReviewers!({ repoSlug: REPO, prId: 'abc', reviewers: ['octocat'] }))
      .rejects.toThrow(/numeric/)
    expect(calls).toHaveLength(0)
  })
})
