import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { resolveContributionCredential } from '../../src/config/contribution-credential'
import { PluginRegistry } from '../../src/plugins/registry'
import type { PluginManifest, ScmPluginRuntime } from '../../src/plugins/types'
import {
  createIsolatedGit,
  fillGitCredential,
  formatGitCredentialResponse,
  gitCredentialHelperCommand,
  httpsCredentialsFromCloneInfo,
  installRepoGitAuth,
  isolatedGitEnv,
  isolatedGitUnsafeOptions,
  parseGitCredentialRequest,
  persistableCloneUrl,
  prepareJobGitAuth,
  remoteUrlFromCredentialRequest,
  runGitCredentialHelper,
  stripUrlUserinfo,
} from '../../src/clients/git-auth'

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

function makeScm(args: {
  id: string
  url: string
  username?: string
  password?: string
  matches?: (remote: string) => boolean
}): ScmPluginRuntime {
  const manifest: PluginManifest = {
    id: args.id,
    kind: 'scm',
    version: '0.0.0',
    displayName: args.id,
    hostCompatibility: '^1.0.0',
    configSchema: z.object({}),
  }
  return {
    manifest,
    kind: 'scm',
    init: async () => {},
    healthcheck: async () => ({ ok: true }),
    dispose: async () => {},
    cloneInfo: () => ({
      url: args.url,
      ...(args.username ? { username: args.username } : {}),
      ...(args.password ? { password: args.password } : {}),
      envForGit: {},
    }),
    matchesRemote: args.matches ?? (remote => remote.includes(args.id) || remote.includes('github.com')),
    pollPr: async () => ({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] }),
    normalizeInbound: () => null,
  } as unknown as ScmPluginRuntime
}

describe('stripUrlUserinfo', () => {
  it('removes HTTPS userinfo', () => {
    expect(stripUrlUserinfo('https://x-access-token:gho_secret@github.com/acme/svc.git'))
      .toBe('https://github.com/acme/svc.git')
  })

  it('leaves a clean HTTPS URL unchanged', () => {
    expect(stripUrlUserinfo('https://github.com/acme/svc.git')).toBe('https://github.com/acme/svc.git')
  })

  it('leaves SSH remotes unchanged', () => {
    expect(stripUrlUserinfo('git@github.com:acme/svc.git')).toBe('git@github.com:acme/svc.git')
  })
})

describe('httpsCredentialsFromCloneInfo', () => {
  it('prefers explicit username/password', () => {
    expect(httpsCredentialsFromCloneInfo({
      url: 'https://github.com/acme/svc.git',
      username: 'x-access-token',
      password: 'gho_live',
      envForGit: {},
    })).toEqual({ username: 'x-access-token', password: 'gho_live' })
  })

  it('falls back to userinfo on a legacy credentialed URL', () => {
    expect(httpsCredentialsFromCloneInfo({
      url: 'https://x-access-token:old_pat@github.com/acme/svc.git',
      envForGit: {},
    })).toEqual({ username: 'x-access-token', password: 'old_pat' })
  })
})

describe('persistableCloneUrl', () => {
  it('strips userinfo from a legacy URL', () => {
    expect(persistableCloneUrl({
      url: 'https://oauth2:glpat@gitlab.com/team/svc.git',
      envForGit: {},
    })).toBe('https://gitlab.com/team/svc.git')
  })
})

describe('git credential protocol', () => {
  it('parses a helper request and rebuilds the remote URL', () => {
    const req = parseGitCredentialRequest(
      'protocol=https\nhost=github.com\npath=emreertugrul/coro.git\n\n',
    )
    expect(req).toEqual({
      protocol: 'https',
      host: 'github.com',
      path: 'emreertugrul/coro.git',
    })
    expect(remoteUrlFromCredentialRequest(req!)).toBe('https://github.com/emreertugrul/coro.git')
  })

  it('formats a helper response', () => {
    expect(formatGitCredentialResponse({ username: 'x-access-token', password: 'tok' }))
      .toBe('username=x-access-token\npassword=tok\n')
  })

  it('fills from the plugin that matches the host', () => {
    const registry = new PluginRegistry()
    registry.register(makeScm({
      id: 'github',
      url: 'https://github.com/acme/svc.git',
      username: 'x-access-token',
      password: 'gho_from_plugin',
    }))
    const creds = fillGitCredential(
      { protocol: 'https', host: 'github.com', path: 'acme/svc.git' },
      registry,
    )
    expect(creds).toEqual({ username: 'x-access-token', password: 'gho_from_plugin' })
  })

  it('returns nothing for an unknown host so git does not learn another helper', async () => {
    const registry = new PluginRegistry()
    registry.register(makeScm({
      id: 'github',
      url: 'https://github.com/acme/svc.git',
      username: 'x-access-token',
      password: 'gho_from_plugin',
      matches: remote => remote.includes('github.com'),
    }))
    const body = await runGitCredentialHelper({
      operation: 'get',
      stdin: 'protocol=https\nhost=evil.example\npath=x/y.git\n',
      registry,
    })
    expect(body).toBe('')
  })

  it('ignores store/erase', async () => {
    const registry = new PluginRegistry()
    const body = await runGitCredentialHelper({
      operation: 'store',
      stdin: 'protocol=https\nhost=github.com\n',
      registry,
    })
    expect(body).toBe('')
  })

  it('returns the new password after the plugin token changes', () => {
    const registry = new PluginRegistry()
    const plugin = makeScm({
      id: 'github',
      url: 'https://github.com/acme/svc.git',
      username: 'x-access-token',
      password: 'old',
    })
    let password = 'old'
    plugin.cloneInfo = () => ({
      url: 'https://github.com/acme/svc.git',
      username: 'x-access-token',
      password,
      envForGit: {},
    })
    registry.register(plugin)
    expect(fillGitCredential({ protocol: 'https', host: 'github.com' }, registry)?.password).toBe('old')
    password = 'new'
    expect(fillGitCredential({ protocol: 'https', host: 'github.com' }, registry)?.password).toBe('new')
  })
})

// A retrospective creates the contribution fork with `upstream.token`, then
// dispatches a job to write the fix on it. Before this, the job's push
// authenticated as the SCM plugin instead — a different account, which GitHub
// refused only after the work was committed.
describe('git credentials for the contribution fork', () => {
  const contribution = resolveContributionCredential({
    repoUrl: 'https://github.com/Coro-ai-framework/coro-developer-framework',
    forkOwner: 'kkbrs',
    token: 'ghp_contribution',
  })!

  function registryWithPluginToken(): PluginRegistry {
    const registry = new PluginRegistry()
    registry.register(makeScm({
      id: 'github',
      url: 'https://github.com/acme/svc.git',
      username: 'x-access-token',
      password: 'gho_plugin',
      matches: remote => remote.includes('github.com'),
    }))
    return registry
  }

  it('answers for the fork with the account that created it', () => {
    expect(fillGitCredential(
      { protocol: 'https', host: 'github.com', path: 'kkbrs/coro-developer-framework.git' },
      registryWithPluginToken(),
      contribution,
    )).toEqual({ username: 'x-access-token', password: 'ghp_contribution' })
  })

  it('leaves every other repository on the same host with the plugin token', () => {
    expect(fillGitCredential(
      { protocol: 'https', host: 'github.com', path: 'A5Labs-Prime/some-service.git' },
      registryWithPluginToken(),
      contribution,
    )).toEqual({ username: 'x-access-token', password: 'gho_plugin' })
  })

  it('answers for the fork even when no plugin claims the host', () => {
    // A Bitbucket-only install contributing to a project on GitHub: the
    // contribution identity owns named repositories, so it does not depend on
    // a GitHub plugin being installed.
    expect(fillGitCredential(
      { protocol: 'https', host: 'github.com', path: 'kkbrs/coro-developer-framework.git' },
      new PluginRegistry(),
      contribution,
    )).toEqual({ username: 'x-access-token', password: 'ghp_contribution' })
  })

  it('keeps the plugin token when the install has no separate contribution token', () => {
    expect(fillGitCredential(
      { protocol: 'https', host: 'github.com', path: 'kkbrs/coro-developer-framework.git' },
      registryWithPluginToken(),
      undefined,
    )).toEqual({ username: 'x-access-token', password: 'gho_plugin' })
  })

  it('does not answer for a same-named repo under another account', () => {
    expect(fillGitCredential(
      { protocol: 'https', host: 'github.com', path: 'someone-else/coro-developer-framework.git' },
      registryWithPluginToken(),
      contribution,
    )).toEqual({ username: 'x-access-token', password: 'gho_plugin' })
  })

  it('reaches the helper protocol end to end', async () => {
    const body = await runGitCredentialHelper({
      operation: 'get',
      stdin: 'protocol=https\nhost=github.com\npath=kkbrs/coro-developer-framework.git\n',
      registry: registryWithPluginToken(),
      contribution,
    })
    expect(body).toBe('username=x-access-token\npassword=ghp_contribution\n')
  })
})

describe('gitCredentialHelperCommand', () => {
  it('emits a !-form helper that resets via a quoted argv', () => {
    const cmd = gitCredentialHelperCommand({ argv: ['/usr/bin/node', '/app/cli/index.js', 'git-credential'] })
    expect(cmd.startsWith('!')).toBe(true)
    expect(cmd).toContain('git-credential')
    expect(cmd).toContain("'/usr/bin/node'")
  })
})

describe('createIsolatedGit / simple-git 3.36 scanner', () => {
  it('injects the live credential helper through GIT_CONFIG_COUNT', () => {
    const env = isolatedGitEnv()
    expect(env.GIT_CONFIG_COUNT).toBe('5')
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper')
    expect(env.GIT_CONFIG_VALUE_0).toBe('')
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.helper')
    expect(env.GIT_CONFIG_VALUE_1).toMatch(/^!/)
    // Without this the helper is asked for a host and never for a repository,
    // so a per-repository identity can never be honoured.
    expect(env.GIT_CONFIG_KEY_2).toBe('credential.useHttpPath')
    expect(env.GIT_CONFIG_VALUE_2).toBe('true')
    expect(env.GIT_CONFIG_KEY_3).toBe('http.lowSpeedLimit')
    expect(env.GIT_CONFIG_VALUE_3).toBe('1000')
    expect(env.GIT_CONFIG_KEY_4).toBe('http.lowSpeedTime')
    expect(env.GIT_CONFIG_VALUE_4).toBe('60')
    expect(env.GIT_ASKPASS).toBe('')
    expect(env.GIT_CONFIG_GLOBAL).toBe(process.platform === 'win32' ? 'NUL' : '/dev/null')
  })

  it('keeps every credential slot inside the declared count', () => {
    // A stale GIT_CONFIG_COUNT silently drops the trailing pairs, and the one
    // most likely to be dropped is whichever was added last.
    const env = isolatedGitEnv()
    const declared = Number(env.GIT_CONFIG_COUNT)
    for (let i = 0; i < declared; i++) {
      expect(env[`GIT_CONFIG_KEY_${i}`], `slot ${i}`).toBeTruthy()
    }
    expect(env[`GIT_CONFIG_KEY_${declared}`]).toBeUndefined()
  })

  it('opts into every scanner class isolatedGitEnv actually uses', () => {
    expect(isolatedGitUnsafeOptions).toEqual({
      allowUnsafeProtocolOverride: false,
      allowUnsafeAskPass: true,
      allowUnsafeConfigPaths: true,
      allowUnsafeConfigEnvCount: true,
      allowUnsafeCredentialHelper: true,
    })
  })

  it('can spawn git with that env — the scanner does not throw', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'coro-isolated-git-'))
    try {
      const out = await createIsolatedGit(dir).raw(['--version'])
      expect(out).toMatch(/git version/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('clones a local repository with the live-helper env applied', async () => {
    const src = mkdtempSync(path.join(os.tmpdir(), 'coro-isolated-src-'))
    const destRoot = mkdtempSync(path.join(os.tmpdir(), 'coro-isolated-dst-'))
    try {
      execFileSync('git', ['init', src], { encoding: 'utf8' })
      execFileSync('git', ['-C', src, 'config', 'user.email', 't@example.com'])
      execFileSync('git', ['-C', src, 'config', 'user.name', 't'])
      execFileSync('git', ['-C', src, 'commit', '--allow-empty', '-m', 'init'])
      const dest = path.join(destRoot, 'copy')
      await createIsolatedGit(destRoot).clone(src, dest)
      expect(existsSync(path.join(dest, '.git'))).toBe(true)
    } finally {
      rmSync(src, { recursive: true, force: true })
      rmSync(destRoot, { recursive: true, force: true })
    }
  })
})

describe('installRepoGitAuth / prepareJobGitAuth', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function initRepo(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'coro-git-auth-'))
    dirs.push(dir)
    execFileSync('git', ['init', dir], { encoding: 'utf8' })
    execFileSync('git', ['-C', dir, 'config', 'user.email', 't@example.com'])
    execFileSync('git', ['-C', dir, 'config', 'user.name', 't'])
    return dir
  }

  it('strips a baked token from origin and installs the reset helper', async () => {
    const repo = initRepo()
    git(repo, 'remote', 'add', 'origin', 'https://x-access-token:stale_pat@github.com/acme/svc.git')

    await installRepoGitAuth(repo, {
      matchesRemote: url => url.includes('github.com'),
      helperCommand: "!/bin/echo git-credential",
    })

    expect(git(repo, 'remote', 'get-url', 'origin')).toBe('https://github.com/acme/svc.git')
    const helpers = execFileSync('git', ['-C', repo, 'config', '--local', '--get-all', 'credential.helper'], {
      encoding: 'utf8',
    })
    expect(helpers).toMatch(/^(\n)?/)
    const lines = helpers.split('\n').filter(l => l.length > 0 || l === '')
    // First entry is the empty reset; second is our helper.
    const all = execFileSync('git', ['-C', repo, 'config', '--local', '--get-all', 'credential.helper'], {
      encoding: 'utf8',
    }).split('\n')
    expect(all[0]).toBe('')
    expect(all[1]).toBe('!/bin/echo git-credential')
    // Without this git asks the helper about a host, never about a repo, so
    // the contribution fork cannot be told apart from any other GitHub repo.
    expect(git(repo, 'config', '--local', '--get', 'credential.useHttpPath')).toBe('true')
  })

  it('does not rewrite a remote the plugin does not claim', async () => {
    const repo = initRepo()
    git(repo, 'remote', 'add', 'origin', 'https://user:tok@other.example/acme/svc.git')
    await installRepoGitAuth(repo, {
      matchesRemote: () => false,
      helperCommand: '!true',
    })
    expect(git(repo, 'remote', 'get-url', 'origin')).toBe('https://user:tok@other.example/acme/svc.git')
  })

  it('prepareJobGitAuth walks nested checkouts and skips _intelligence', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'coro-job-'))
    dirs.push(root)
    const checkout = path.join(root, 'acme', 'svc')
    mkdirSync(checkout, { recursive: true })
    execFileSync('git', ['init', checkout])
    git(checkout, 'remote', 'add', 'origin', 'https://x-access-token:old@github.com/acme/svc.git')

    const intel = path.join(root, '_intelligence')
    mkdirSync(intel, { recursive: true })
    execFileSync('git', ['init', intel])
    git(intel, 'remote', 'add', 'origin', 'https://x-access-token:intel@github.com/acme/intel.git')

    const registry = new PluginRegistry()
    registry.register(makeScm({
      id: 'github',
      url: 'https://github.com/acme/svc.git',
      username: 'x-access-token',
      password: 'live',
    }))

    await prepareJobGitAuth(root, registry, '!true')
    expect(git(checkout, 'remote', 'get-url', 'origin')).toBe('https://github.com/acme/svc.git')
    expect(git(intel, 'remote', 'get-url', 'origin')).toBe('https://x-access-token:intel@github.com/acme/intel.git')
  })
})

describe('github plugin cloneInfo', () => {
  it('emits a clean URL and the live token on password', async () => {
    const { createGitHubScmPlugin } = await import('../../src/plugins/builtin/github')
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never
    const plugin = createGitHubScmPlugin({ config: {}, logger })
    await plugin.init(
      { owner: 'acme', token: 'gho_live' },
      { logger, fetch: globalThis.fetch } as never,
    )
    const info = plugin.cloneInfo({ repo: 'someone/svc' })
    expect(info.url).toBe('https://github.com/someone/svc.git')
    expect(info.username).toBe('x-access-token')
    expect(info.password).toBe('gho_live')
    expect(info.url).not.toContain('gho_live')
  })

  it('reports the contribution token for the fork and the plugin token elsewhere', async () => {
    const plugin = await contributionPlugin()

    expect(plugin.cloneInfo({ repo: 'kkbrs/coro-developer-framework' }).password)
      .toBe('ghp_contribution')
    expect(plugin.cloneInfo({ repo: 'acme/svc' }).password).toBe('gho_live')
    // A bare name resolves against the plugin's own owner, so it is never the
    // contribution fork even when the repo name matches.
    expect(plugin.cloneInfo({ repo: 'coro-developer-framework' }).password).toBe('gho_live')
  })

  it('drops the contribution identity when Settings clears the token', async () => {
    const plugin = await contributionPlugin()
    plugin.setContributionCredential?.(undefined)
    expect(plugin.cloneInfo({ repo: 'kkbrs/coro-developer-framework' }).password).toBe('gho_live')
  })
})

// The other half of the same identity: a cross-repository PR is created
// against upstream with a head branch on the fork, and GitHub attributes that
// call to whoever owns the head. Authenticating it as the SCM plugin is the
// failure that lands one phase after the push.
describe('github plugin createPr identity', () => {
  it('opens the contribution PR as the account that owns the fork', async () => {
    const seen: string[] = []
    const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push(String(init?.headers?.['Authorization'] ?? ''))
      return {
        ok: true,
        status: 201,
        json: async () => ({
          number: 7,
          title: 't',
          state: 'open',
          head: { ref: 'fix/x' },
          base: { ref: 'main' },
          user: { login: 'kkbrs' },
          html_url: 'https://github.com/Coro-ai-framework/coro-developer-framework/pull/7',
        }),
        text: async () => '{}',
        headers: new Headers(),
      } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    const plugin = await contributionPlugin()
    await plugin.createPr?.({
      repoSlug: 'Coro-ai-framework/coro-developer-framework',
      title: 'Fix the thing',
      sourceBranch: 'fix/x',
      sourceOwner: 'kkbrs',
      targetBranch: 'main',
    })

    expect(seen.some(header => header.includes('ghp_contribution'))).toBe(true)
    expect(seen.some(header => header.includes('gho_live'))).toBe(false)
  })
})

/** GitHub SCM plugin with the plugin token `gho_live` and a contribution fork under `kkbrs`. */
async function contributionPlugin(): Promise<ScmPluginRuntime> {
  const { createGitHubScmPlugin } = await import('../../src/plugins/builtin/github')
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never
  const plugin = createGitHubScmPlugin({ config: {}, logger })
  await plugin.init(
    { owner: 'acme', token: 'gho_live' },
    { logger, fetch: globalThis.fetch } as never,
  )
  plugin.setContributionCredential?.(resolveContributionCredential({
    repoUrl: 'https://github.com/Coro-ai-framework/coro-developer-framework',
    forkOwner: 'kkbrs',
    token: 'ghp_contribution',
  }))
  return plugin
}
