// Token probes must not name a model. A Messages ping couples auth to
// whichever catalogue id is "cheap" this quarter, and Anthropic's OAuth
// entitlement gate then rejects otherwise-valid subscription tokens.
// These tests pin GET /v1/models as the only upstream call.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { testAnthropicCredentials } from '../src/test-connection'
import {
  loadClaudeLocalSession,
  readClaudeLocalSession,
  refreshClaudeLocalSession,
  type ClaudeLocalSession,
} from '../src/credential-store'

vi.mock('../src/credential-store', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/credential-store')>()
  return {
    ...actual,
    loadClaudeLocalSession: vi.fn(),
    readClaudeLocalSession: vi.fn(),
    refreshClaudeLocalSession: vi.fn(),
  }
})

const loadSession = vi.mocked(loadClaudeLocalSession)
const readSession = vi.mocked(readClaudeLocalSession)
const refreshSession = vi.mocked(refreshClaudeLocalSession)

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function session(overrides: Partial<ClaudeLocalSession> = {}): ClaudeLocalSession {
  return {
    accessToken: 'sk-ant-oat01-live',
    refreshToken: 'sk-ant-ort01-live',
    expiresAt: Date.now() + 8 * 60 * 60 * 1000,
    accountEmail: 'dev@example.com',
    organizationName: 'Acme',
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
  loadSession.mockReset()
  readSession.mockReset()
  refreshSession.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function fetchMock(): ReturnType<typeof vi.fn> {
  return vi.mocked(fetch)
}

function lastRequest(): { url: string; init: RequestInit } {
  const call = fetchMock().mock.calls[0]
  expect(call).toBeTruthy()
  return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit }
}

describe('testAnthropicCredentials — model-agnostic probe', () => {
  it('rejects a missing API key without calling Anthropic', async () => {
    const result = await testAnthropicCredentials({ method: 'apiKey', apiKey: '  ' })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/API key is required/)
    expect(fetchMock()).not.toHaveBeenCalled()
  })

  it('validates an API key with GET /v1/models, not Messages', async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, { data: [{ id: 'claude-sonnet-5' }] }))

    const result = await testAnthropicCredentials({ method: 'apiKey', apiKey: 'sk-ant-api03-x' })

    expect(result.ok).toBe(true)
    const { url, init } = lastRequest()
    expect(url).toBe('https://api.anthropic.com/v1/models')
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
    const headers = new Headers(init.headers)
    expect(headers.get('x-api-key')).toBe('sk-ant-api03-x')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
  })

  it('sends the OAuth beta header for a pasted oauth token', async () => {
    fetchMock().mockResolvedValue(jsonResponse(200, { data: [] }))

    const result = await testAnthropicCredentials({
      method: 'oauth',
      oauthToken: 'sk-ant-oat01-pasted',
    })

    expect(result.ok).toBe(true)
    const { url, init } = lastRequest()
    expect(url).toBe('https://api.anthropic.com/v1/models')
    expect(init.method).toBe('GET')
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Bearer sk-ant-oat01-pasted')
    expect(headers.get('anthropic-beta')).toBe('oauth-2025-04-20')
  })

  it('probes a Claude login session without naming a model', async () => {
    loadSession.mockResolvedValue(session())
    fetchMock().mockResolvedValue(jsonResponse(200, { data: [] }))

    const result = await testAnthropicCredentials({ method: 'claudeLogin' })

    expect(result.ok).toBe(true)
    expect(result.message).toContain('dev@example.com')
    expect(refreshSession).not.toHaveBeenCalled()
    const { url, init } = lastRequest()
    expect(url).toBe('https://api.anthropic.com/v1/models')
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
    const body = init.body ? String(init.body) : ''
    expect(body).not.toMatch(/claude-/)
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Bearer sk-ant-oat01-live')
    expect(headers.get('anthropic-beta')).toBe('oauth-2025-04-20')
  })

  it('renews once on 401 and succeeds with the rotated token', async () => {
    loadSession.mockResolvedValue(session())
    refreshSession.mockResolvedValue(true)
    readSession.mockReturnValue(session({ accessToken: 'sk-ant-oat01-rotated' }))
    fetchMock()
      .mockResolvedValueOnce(
        jsonResponse(401, { error: { message: 'invalid x-api-key' } }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }))

    const result = await testAnthropicCredentials({ method: 'claudeLogin' })

    expect(result.ok).toBe(true)
    expect(fetchMock()).toHaveBeenCalledTimes(2)
    const second = fetchMock().mock.calls[1]
    const headers = new Headers((second[1] as RequestInit).headers)
    expect(headers.get('authorization')).toBe('Bearer sk-ant-oat01-rotated')
  })

  it('reports a revoked session only when Anthropic 401s after renew', async () => {
    loadSession.mockResolvedValue(session())
    refreshSession.mockResolvedValue(true)
    readSession.mockReturnValue(session())
    fetchMock().mockResolvedValue(
      jsonResponse(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
    )

    const result = await testAnthropicCredentials({ method: 'claudeLogin' })

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/rejected the token, and renewing it did not help/)
    expect(result.hint).toMatch(/revoked/)
  })

  it('does not treat a 429 as a revoked token and does not refresh', async () => {
    loadSession.mockResolvedValue(session())
    fetchMock().mockResolvedValue(
      jsonResponse(429, { error: { type: 'rate_limit_error', message: 'Error' } }),
    )

    const result = await testAnthropicCredentials({ method: 'claudeLogin' })

    expect(result.ok).toBe(false)
    expect(refreshSession).not.toHaveBeenCalled()
    expect(result.message).toMatch(/HTTP 429/)
    expect(result.hint).toMatch(/credential is valid/)
    expect(result.message).not.toMatch(/revoked|renewing/)
  })

  it('does not call Anthropic when the stored session is expired and unrestorable', async () => {
    loadSession.mockResolvedValue(session({ expiresAt: Date.now() - 1000 }))

    const result = await testAnthropicCredentials({ method: 'claudeLogin' })

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/expired and could not be renewed/)
    expect(fetchMock()).not.toHaveBeenCalled()
  })
})
