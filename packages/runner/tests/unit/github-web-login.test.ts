// GitHub browser sign-in (`gh auth login --web`).
//
// Without a terminal `gh` never opens a browser and prints its one-time code
// to output the runner used to discard, so the dashboard sat on "Waiting for
// browser…" until the five-minute timeout. And because every status poll
// adopted whatever account `gh` already had active, a second account could
// never be connected. These tests pin the prompt hand-off and the
// account-selection rules.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import pino from 'pino'
import type { PluginHttpRoutesContext, PluginOAuthStatus } from '@coro-ai/plugin-sdk'

const gh = vi.hoisted(() => ({
  ghCommandExists: vi.fn(),
  tryGhAuthToken: vi.fn(),
  validateGithubToken: vi.fn(),
  startGhWebLogin: vi.fn(),
}))

vi.mock('../../src/plugins/builtin/github/gh-session', async importActual => ({
  ...(await importActual<typeof import('../../src/plugins/builtin/github/gh-session')>()),
  ...gh,
}))

import { parseGhDevicePrompt } from '../../src/plugins/builtin/github/gh-session'
import { registerGitHubOAuthRoutes } from '../../src/plugins/builtin/github/oauth-routes'

type Handler = (req: { body?: unknown }, res: { json: (body: unknown) => void; status: (code: number) => unknown }) => Promise<void>

let pluginSeq = 0

function setup() {
  const pluginId = `github-test-${++pluginSeq}`
  const handlers = new Map<string, Handler>()
  const saved: Array<Record<string, unknown>> = []
  const ctx = {
    app: {
      get: (path: string, handler: Handler) => handlers.set(`GET ${path}`, handler),
      post: (path: string, handler: Handler) => handlers.set(`POST ${path}`, handler),
    },
    logger: pino({ level: 'silent' }),
    saveLocalConfig: () => {},
    savePluginConfig: (_id: string, patch: Record<string, unknown>) => saved.push(patch),
    redactSecret: (v: string | undefined | null) => (v ? '***' : ''),
  } as unknown as PluginHttpRoutesContext
  registerGitHubOAuthRoutes(ctx, { pluginId, ownerConfigKey: 'owner' })

  const base = `/config/plugins/${pluginId}/auth/gh-cli-web`
  const call = async (key: string, body?: unknown): Promise<PluginOAuthStatus> => {
    let out: unknown
    const res = { json: (b: unknown) => { out = b }, status: () => res }
    await handlers.get(key)!({ body }, res)
    return out as PluginOAuthStatus
  }
  return {
    saved,
    start: (body?: unknown) => call(`POST ${base}/start`, body),
    status: () => call(`GET ${base}/status`),
  }
}

function fakeLogin() {
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  const login = {
    prompt: Promise.resolve({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' }),
    done,
    cancel: vi.fn(),
  }
  gh.startGhWebLogin.mockReturnValue(login)
  return { finish }
}

beforeEach(() => {
  vi.clearAllMocks()
  gh.ghCommandExists.mockResolvedValue(true)
  gh.validateGithubToken.mockImplementation(async (_f: unknown, token: string) =>
    ({ login: token === 'work-token' ? 'work-account' : 'personal-account' }))
})

describe('parseGhDevicePrompt', () => {
  it('reads the clipboard-style prompt current gh prints', () => {
    expect(parseGhDevicePrompt(
      '! One-time code (0539-10C2) copied to clipboard\nOpen this URL to continue in your web browser: https://github.com/login/device\n',
    )).toEqual({ userCode: '0539-10C2', verificationUri: 'https://github.com/login/device' })
  })

  it('reads the older prompt and falls back to the github.com device page', () => {
    expect(parseGhDevicePrompt('\x1b[33m!\x1b[0m First copy your one-time code: \x1b[1mWXYZ-9876\x1b[0m\n'))
      .toEqual({ userCode: 'WXYZ-9876', verificationUri: 'https://github.com/login/device' })
  })

  it('returns null until the code has been printed', () => {
    expect(parseGhDevicePrompt('Open this URL to continue in your web browser: https://github.com/login/device')).toBeNull()
  })
})

describe('GitHub browser sign-in routes', () => {
  it('returns the one-time code and verification page from start', async () => {
    gh.tryGhAuthToken.mockResolvedValue(null)
    fakeLogin()
    const { start } = setup()

    expect(await start()).toMatchObject({
      state: 'pending',
      userCode: 'ABCD-1234',
      authorizeUrl: 'https://github.com/login/device',
      message: expect.stringContaining('switch accounts'),
    })
  })

  it('Reconnect starts a browser sign-in instead of reusing the current gh account', async () => {
    gh.tryGhAuthToken.mockResolvedValue('personal-token')
    fakeLogin()
    const { start } = setup()

    expect(await start()).toMatchObject({ state: 'success', account: { label: 'personal-account' } })
    expect(await start({ force: true })).toMatchObject({ state: 'pending', userCode: 'ABCD-1234' })
    expect(gh.startGhWebLogin).toHaveBeenCalledTimes(1)
  })

  it('does not adopt the already-active gh account while the user is still signing in', async () => {
    gh.tryGhAuthToken.mockResolvedValue('personal-token')
    const login = fakeLogin()
    const { start, status, saved } = setup()

    await start({ force: true })
    saved.length = 0
    expect(await status()).toMatchObject({ state: 'pending', userCode: 'ABCD-1234' })
    expect(saved).toEqual([])

    // gh makes the newly signed-in account active once the login completes.
    gh.tryGhAuthToken.mockResolvedValue('work-token')
    login.finish()
    await vi.waitFor(async () => {
      expect(await status()).toMatchObject({ state: 'success', account: { label: 'work-account' } })
    })
    expect(saved).toContainEqual({ owner: 'work-account', token: 'work-token' })
  })
})
