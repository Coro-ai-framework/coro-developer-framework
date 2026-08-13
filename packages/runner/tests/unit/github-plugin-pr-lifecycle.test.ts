// The GitHub plugin must serve the PR lifecycle itself.
//
// Regression origin: the S4 "MCP-first pivot" removed these methods so the
// generic `scm_*` proxy would redirect agents to the native `mcp__github__*`
// tools. Those redirects are returned with `isError: true` (deliberately, so
// Claude Code treats them as a "use this other tool" hint), which meant an
// agent working a PR saw failures from five tools in a row. One job read that
// as a systemic parameter-serialization bug in Coro and escalated instead of
// merging a green PR.
//
// The proxy only redirects for operations a plugin leaves undefined, so these
// tests assert the methods exist and reach the REST client. Bitbucket has
// always served them locally; GitHub now matches.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import pino from 'pino'
import { createGitHubScmPlugin } from '../../src/plugins/builtin/github'
import type { ScmPluginRuntime } from '../../src/plugins/types'
import type { ExternalRef } from '@coro-ai/cloud-protocol'

const logger = pino({ level: 'silent' })

const REPO = 'A5Labs-Prime/a5labs.dashboard-api-go'

function prRef(prId: number): ExternalRef {
  return { kind: 'pull_request', pluginId: 'github', repoKey: REPO, externalId: String(prId) }
}

const GH_PR = {
  id: 100, number: 5, title: 'A PR', body: '', state: 'open', merged: false,
  head: { ref: 'feat/x' }, base: { ref: 'main' }, user: { login: 'someone' },
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  html_url: 'https://github.com/x/y/pull/5',
}

/** Records requests and replies with something each caller can parse. */
function mockFetch(): { calls: Array<{ method: string; path: string }> } {
  const calls: Array<{ method: string; path: string }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET'
    const path = new URL(String(url)).pathname
    calls.push({ method, path })

    const comment = { id: 1, body: 'hi', created_at: '', updated_at: '' }
    let body: unknown = GH_PR
    if (method === 'GET' && /\/(reviews|comments)$/.test(path)) body = []
    else if (/\/(comments|replies)$/.test(path)) body = comment

    return {
      ok: true, status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: new Headers(),
    } as unknown as Response
  }))
  return { calls }
}

async function makePlugin(): Promise<ScmPluginRuntime> {
  const config = { owner: 'A5Labs-Prime', token: 'test-token' }
  const plugin = createGitHubScmPlugin({ config, logger })
  await plugin.init(config, { logger } as never)
  return plugin
}

describe('GitHub plugin PR lifecycle', () => {
  let plugin: ScmPluginRuntime

  beforeEach(async () => {
    vi.unstubAllGlobals()
    plugin = await makePlugin()
  })

  // The proxy's redirect branch is `if (!r.scm.<method>)`, so presence alone
  // decides whether an agent gets data or an isError redirect.
  it.each([
    'createPr',
    'getPrStatus',
    'listPrComments',
    'postPrComment',
    'replyToComment',
    'approvePr',
    'mergePr',
  ])('implements %s so scm_* does not redirect', method => {
    expect(typeof (plugin as unknown as Record<string, unknown>)[method]).toBe('function')
  })

  it('getPrStatus reads the PR through the REST client', async () => {
    const { calls } = mockFetch()
    const status = await plugin.getPrStatus!(prRef(5))

    expect(status).toEqual({ state: 'open', approvalCount: 0 })
    expect(calls.map(c => c.path)).toContain(`/repos/${REPO}/pulls/5`)
  })

  it('listPrComments returns normalised comments', async () => {
    mockFetch()
    const comments = await plugin.listPrComments!(prRef(5))
    expect(Array.isArray(comments)).toBe(true)
  })

  it('postPrComment posts through the issues API', async () => {
    const { calls } = mockFetch()
    const posted = await plugin.postPrComment!(prRef(5), 'hi')

    expect(posted.body).toBe('hi')
    expect(calls).toContainEqual({ method: 'POST', path: `/repos/${REPO}/issues/5/comments` })
  })

  it('mergePr merges through the REST client', async () => {
    const { calls } = mockFetch()
    await plugin.mergePr!(prRef(5), { message: 'ship it' })

    expect(calls).toContainEqual({ method: 'PUT', path: `/repos/${REPO}/pulls/5/merge` })
  })

  it('approvePr submits a review', async () => {
    const { calls } = mockFetch()
    await plugin.approvePr!(prRef(5))

    expect(calls).toContainEqual({ method: 'POST', path: `/repos/${REPO}/pulls/5/reviews` })
  })

  it('replyToComment rejects a non-numeric parent id rather than calling the API', async () => {
    const { calls } = mockFetch()
    await expect(plugin.replyToComment!(prRef(5), 'abc', 'hi')).rejects.toThrow(/not a number/)
    expect(calls).toHaveLength(0)
  })
})
