// Tests for the Claude CLI credential store reader + refresh path.
//
// The behaviour under test is what keeps a `claudeLogin` session alive:
// Anthropic caps claude.ai access tokens at 8 hours, so an expired token is
// routine and must be renewed from the stored refresh token rather than
// reported as a failure that demands a manual reconnect.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFile, execFileSync } from 'child_process'
import {
  isSessionExpired,
  loadClaudeLocalSession,
  readClaudeLocalSession,
  refreshClaudeLocalSession,
  resetRefreshCooldown,
} from '../src/credential-store'

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}))

vi.mock('../src/cli-path', () => ({
  resolveClaudeCodeCliPath: () => '/fake/path/to/claude',
  ensureClaudeCodeCliExecutable: () => undefined,
}))

const execFileMock = vi.mocked(execFile)
const execFileSyncMock = vi.mocked(execFileSync)

const originalPlatform = process.platform

/** Pretend to be macOS so the reader takes the keychain branch. */
function forcePlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function storedBlob(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-current',
      refreshToken: 'sk-ant-ort01-current',
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      scopes: ['user:profile', 'user:inference', 'user:mcp_servers'],
      ...overrides,
    },
  })
}

/** Make the mocked `execFile` invoke its callback with success or failure. */
function stubRefresh(outcome: 'success' | 'failure'): void {
  execFileMock.mockImplementation(((
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    if (outcome === 'success') callback(null, 'Login successful.\n', '')
    else callback(new Error('exit 1'), '', 'Login failed: expired_refresh_token\n')
    return undefined as never
  }) as unknown as typeof execFile)
}

beforeEach(() => {
  forcePlatform('darwin')
  execFileMock.mockReset()
  execFileSyncMock.mockReset()
  resetRefreshCooldown()
})

afterEach(() => {
  forcePlatform(originalPlatform)
})

describe('isSessionExpired', () => {
  it('treats a session with no recorded expiry as usable', () => {
    expect(isSessionExpired(undefined)).toBe(false)
  })

  it('treats a token with hours left as usable', () => {
    expect(isSessionExpired(Date.now() + 8 * 60 * 60 * 1000)).toBe(false)
  })

  it('treats an already-expired token as expired', () => {
    expect(isSessionExpired(Date.now() - 1000)).toBe(true)
  })

  it('treats a token inside the safety buffer as expired', () => {
    expect(isSessionExpired(Date.now() + 5_000)).toBe(true)
  })
})

describe('readClaudeLocalSession', () => {
  it('parses the claudeAiOauth blob from the keychain', () => {
    execFileSyncMock.mockReturnValue(storedBlob() as never)
    const session = readClaudeLocalSession()
    expect(session.accessToken).toBe('sk-ant-oat01-current')
    expect(session.refreshToken).toBe('sk-ant-ort01-current')
    expect(session.scopes).toContain('user:mcp_servers')
  })

  it('reports a clear error when there is no keychain entry', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('exit 44')
    })
    expect(() => readClaudeLocalSession()).toThrow(/No Claude Code keychain entry/)
  })
})

describe('loadClaudeLocalSession', () => {
  it('does not refresh a session that is still usable', async () => {
    execFileSyncMock.mockReturnValue(storedBlob() as never)
    const session = await loadClaudeLocalSession()
    expect(session.accessToken).toBe('sk-ant-oat01-current')
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('renews an expired session and returns the new token', async () => {
    execFileSyncMock
      .mockReturnValueOnce(storedBlob({ expiresAt: Date.now() - 1000 }) as never)
      .mockReturnValueOnce(storedBlob({ expiresAt: Date.now() - 1000 }) as never)
      .mockReturnValueOnce(storedBlob({ accessToken: 'sk-ant-oat01-renewed' }) as never)
    stubRefresh('success')

    const session = await loadClaudeLocalSession()

    expect(session.accessToken).toBe('sk-ant-oat01-renewed')
    expect(execFileMock).toHaveBeenCalledTimes(1)
    const [file, args] = execFileMock.mock.calls[0]
    expect(file).toBe('/fake/path/to/claude')
    expect(args).toEqual(['auth', 'login'])
  })

  it('passes the stored refresh token and scopes to the CLI', async () => {
    execFileSyncMock.mockReturnValue(storedBlob({ expiresAt: Date.now() - 1000 }) as never)
    stubRefresh('success')

    await loadClaudeLocalSession()

    const options = execFileMock.mock.calls[0][2] as { env: Record<string, string> }
    expect(options.env['CLAUDE_CODE_OAUTH_REFRESH_TOKEN']).toBe('sk-ant-ort01-current')
    expect(options.env['CLAUDE_CODE_OAUTH_SCOPES']).toBe(
      'user:profile user:inference user:mcp_servers',
    )
    // Either of these would make the CLI ignore the stored session it is
    // supposed to be renewing.
    expect(options.env['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(options.env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined()
  })

  it('returns the still-expired session when the refresh is rejected', async () => {
    execFileSyncMock.mockReturnValue(storedBlob({ expiresAt: Date.now() - 1000 }) as never)
    stubRefresh('failure')

    const session = await loadClaudeLocalSession()

    expect(isSessionExpired(session.expiresAt)).toBe(true)
    expect(session.accessToken).toBe('sk-ant-oat01-current')
  })

  it('propagates a missing credential store instead of refreshing', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('exit 44')
    })
    await expect(loadClaudeLocalSession()).rejects.toThrow(/No Claude Code keychain entry/)
    expect(execFileMock).not.toHaveBeenCalled()
  })
})

describe('refreshClaudeLocalSession', () => {
  it('declines when the stored session has no refresh token', async () => {
    execFileSyncMock.mockReturnValue(
      storedBlob({ refreshToken: undefined }) as never,
    )
    await expect(refreshClaudeLocalSession()).resolves.toBe(false)
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('declines when there is no credential store to read', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('exit 44')
    })
    await expect(refreshClaudeLocalSession()).resolves.toBe(false)
  })

  it('stops retrying for a cooldown period after a failed exchange', async () => {
    execFileSyncMock.mockReturnValue(storedBlob() as never)
    stubRefresh('failure')

    await expect(refreshClaudeLocalSession()).resolves.toBe(false)
    await expect(refreshClaudeLocalSession()).resolves.toBe(false)
    expect(execFileMock).toHaveBeenCalledTimes(1)

    // A fresh login clears the cooldown so the new session is picked up.
    resetRefreshCooldown()
    stubRefresh('success')
    await expect(refreshClaudeLocalSession()).resolves.toBe(true)
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })

  it('collapses concurrent refreshes into a single exchange', async () => {
    execFileSyncMock.mockReturnValue(storedBlob() as never)
    let release: (() => void) | undefined
    execFileMock.mockImplementation(((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      release = () => callback(null, 'Login successful.\n', '')
      return undefined as never
    }) as unknown as typeof execFile)

    const first = refreshClaudeLocalSession()
    const second = refreshClaudeLocalSession()
    release?.()

    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })
})
