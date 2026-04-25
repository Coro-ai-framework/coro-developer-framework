import { describe, it, expect, vi } from 'vitest'
import { ClaudeLoginManager } from '../../src/runner/claude-login'

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve())
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(resolver => {
    resolve = resolver
  })

  return { promise, resolve }
}

describe('ClaudeLoginManager', () => {
  it('returns connected immediately when Claude already has a persisted login session', async () => {
    const dispose = vi.fn()
    const session = {
      query: {
        initializationResult: vi.fn().mockResolvedValue({}),
        accountInfo: vi.fn().mockResolvedValue({
          email: 'dev@a5labs.com',
          organization: 'A5 Labs',
          apiProvider: 'firstParty',
        }),
        claudeAuthenticate: vi.fn(),
        claudeOAuthWaitForCompletion: vi.fn(),
        claudeOAuthCallback: vi.fn(),
      },
      dispose,
    }

    const manager = new ClaudeLoginManager({
      logger: makeLogger() as never,
      createSession: () => session as never,
    })

    const state = await manager.start()

    if (state.status !== 'connected') {
      throw new Error(`Expected connected state, got ${state.status}`)
    }

    expect(state.status).toBe('connected')
    expect(state.account?.email).toBe('dev@a5labs.com')
    expect(session.query.claudeAuthenticate).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('starts an auth flow and transitions to connected when wait-for-completion resolves', async () => {
    const dispose = vi.fn()
    const deferred = createDeferred<{ account?: { email?: string; apiProvider?: 'firstParty' } }>()

    const session = {
      query: {
        initializationResult: vi.fn().mockResolvedValue({}),
        accountInfo: vi.fn().mockResolvedValue({}),
        claudeAuthenticate: vi.fn().mockResolvedValue({
          manualUrl: 'https://claude.ai/oauth/manual',
          automaticUrl: 'http://127.0.0.1:43110/oauth/start',
        }),
        claudeOAuthWaitForCompletion: vi.fn().mockReturnValue(deferred.promise),
        claudeOAuthCallback: vi.fn(),
      },
      dispose,
    }

    const manager = new ClaudeLoginManager({
      logger: makeLogger() as never,
      createSession: () => session as never,
    })

    const started = await manager.start()
    if (started.status !== 'authorizing') {
      throw new Error(`Expected authorizing state, got ${started.status}`)
    }
    expect(started.status).toBe('authorizing')
    expect(started.manualUrl).toContain('claude.ai')

    deferred.resolve({ account: { email: 'dev@a5labs.com', apiProvider: 'firstParty' } })
    await flushMicrotasks()

    const completed = manager.getState()
    if (completed.status !== 'connected') {
      throw new Error(`Expected connected state, got ${completed.status}`)
    }
    expect(completed.status).toBe('connected')
    expect(completed.account?.email).toBe('dev@a5labs.com')
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('accepts a manual callback and completes the flow', async () => {
    const dispose = vi.fn()
    const session = {
      query: {
        initializationResult: vi.fn().mockResolvedValue({}),
        accountInfo: vi.fn().mockResolvedValue({}),
        claudeAuthenticate: vi.fn().mockResolvedValue({
          manualUrl: 'https://claude.ai/oauth/manual',
        }),
        claudeOAuthWaitForCompletion: vi.fn().mockReturnValue(new Promise(() => {})),
        claudeOAuthCallback: vi.fn().mockResolvedValue({
          account: { email: 'callback@a5labs.com', apiProvider: 'firstParty' },
        }),
      },
      dispose,
    }

    const manager = new ClaudeLoginManager({
      logger: makeLogger() as never,
      createSession: () => session as never,
    })

    await manager.start()
    const completed = await manager.submitCallback({
      authorizationCode: 'auth-code',
      state: 'state-token',
    })

    if (completed.status !== 'connected') {
      throw new Error(`Expected connected state, got ${completed.status}`)
    }

    expect(session.query.claudeOAuthCallback).toHaveBeenCalledWith('auth-code', 'state-token')
    expect(completed.status).toBe('connected')
    expect(completed.account?.email).toBe('callback@a5labs.com')
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})