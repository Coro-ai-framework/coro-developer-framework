import { describe, expect, it, vi } from 'vitest'
import pino from 'pino'
import { createPlugin } from './index'

const logger = pino({ level: 'silent' })

function makePlugin() {
  return createPlugin({ config: {} })
}

describe('@coro-ai/plugin-gitlab', () => {
  it('declares the gitlab manifest', () => {
    const plugin = makePlugin()
    expect(plugin.manifest.id).toBe('gitlab')
    expect(plugin.manifest.kind).toBe('scm')
    expect(plugin.manifest.hostCompatibility).toBe('^1.0.0')
  })

  it('exposes an stdio mcp descriptor after init', async () => {
    const plugin = makePlugin()
    await plugin.init({ namespace: 'team', token: 'glpat-abc' }, { logger, fetch: globalThis.fetch })
    const desc = plugin.mcpServer()
    expect(desc?.type).toBe('stdio')
    if (desc?.type === 'stdio') {
      expect(desc.command).toBe('npx')
      expect(desc.args).toContain('@modelcontextprotocol/server-gitlab')
      expect(desc.env?.GITLAB_PERSONAL_ACCESS_TOKEN).toBe('glpat-abc')
    }
  })

  it('builds a credentialed clone URL', async () => {
    const plugin = makePlugin()
    await plugin.init({ namespace: 'team', token: 'glpat-xyz' }, { logger, fetch: globalThis.fetch })
    const info = plugin.cloneInfo({ repo: 'svc' })
    expect(info.url).toBe('https://oauth2:glpat-xyz@gitlab.com/team/svc.git')
    expect(info.envForGit).toMatchObject({ GIT_TERMINAL_PROMPT: '0' })
  })

  it('matches gitlab.com remotes', async () => {
    const plugin = makePlugin()
    await plugin.init({ namespace: 'team', token: 't' }, { logger, fetch: globalThis.fetch })
    expect(plugin.matchesRemote('git@gitlab.com:team/svc.git')).toBe(true)
    expect(plugin.matchesRemote('https://gitlab.com/team/svc.git')).toBe(true)
    expect(plugin.matchesRemote('https://github.com/team/svc.git')).toBe(false)
  })

  it('matches custom hosts when baseUrl is configured', async () => {
    const plugin = makePlugin()
    await plugin.init(
      { namespace: 'team', token: 't', baseUrl: 'https://gitlab.example.com/api/v4' },
      { logger, fetch: globalThis.fetch },
    )
    expect(plugin.matchesRemote('git@gitlab.example.com:team/svc.git')).toBe(true)
    expect(plugin.matchesRemote('git@gitlab.com:team/svc.git')).toBe(false)
  })

  it('normalizes Merge Request webhook payloads', async () => {
    const plugin = makePlugin()
    await plugin.init({ namespace: 'team', token: 't' }, { logger, fetch: globalThis.fetch })
    const payload = {
      object_kind: 'merge_request',
      project: { path_with_namespace: 'team/svc' },
      object_attributes: {
        iid: 42,
        action: 'open',
        url: 'https://gitlab.com/team/svc/-/merge_requests/42',
      },
    }
    const evt = plugin.normalizeInbound!({
      headers: { 'x-gitlab-event': 'Merge Request Hook' },
      rawBody: Buffer.from(JSON.stringify(payload)),
    })
    expect(evt).not.toBeNull()
    expect(evt!.kind).toBe('pr.opened')
    expect(evt!.ref.kind).toBe('pull_request')
    expect(evt!.ref.repoKey).toBe('svc')
    expect(evt!.ref.externalId).toBe('42')
  })

  it('declares detect auth in manifest', () => {
    const plugin = makePlugin()
    const detect = plugin.manifest.auth?.methods.find(m => m.kind === 'detect')
    expect(detect).toBeDefined()
  })

  it('validates credentials via testConnection', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (url.toString().endsWith('/user')) {
        return new Response(JSON.stringify({ username: 'alice' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const plugin = makePlugin()
    await plugin.init({ namespace: 'team', token: 'glpat-abc' }, { logger, fetch: fetchMock })
    const result = await plugin.testConnection!()
    expect(result.ok).toBe(true)
    expect(result.message).toContain('alice')
  })

  it('opens an MR via REST in writerCreatePr', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = url.toString()
      if (u.endsWith('/merge_requests') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ iid: 7, state: 'opened', web_url: 'https://gitlab.com/team/svc/-/merge_requests/7' }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const plugin = makePlugin()
    await plugin.init({ namespace: 'team', token: 'glpat-abc' }, { logger, fetch: fetchMock })

    const ref = await plugin.writerCreatePr!({
      repoSlug: 'svc',
      title: 'self-improve memory',
      sourceBranch: 'coro/proposal/foo',
    })
    expect(ref.kind).toBe('pull_request')
    expect(ref.pluginId).toBe('gitlab')
    expect(ref.repoKey).toBe('svc')
    expect(ref.externalId).toBe('7')
    expect(ref.url).toBe('https://gitlab.com/team/svc/-/merge_requests/7')
  })
})
