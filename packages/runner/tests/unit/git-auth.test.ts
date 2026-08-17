import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { PluginRegistry } from '../../src/plugins/registry'
import type { PluginManifest, ScmPluginRuntime } from '../../src/plugins/types'
import {
  fillGitCredential,
  formatGitCredentialResponse,
  gitCredentialHelperCommand,
  httpsCredentialsFromCloneInfo,
  installRepoGitAuth,
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

describe('gitCredentialHelperCommand', () => {
  it('emits a !-form helper that resets via a quoted argv', () => {
    const cmd = gitCredentialHelperCommand({ argv: ['/usr/bin/node', '/app/cli/index.js', 'git-credential'] })
    expect(cmd.startsWith('!')).toBe(true)
    expect(cmd).toContain('git-credential')
    expect(cmd).toContain("'/usr/bin/node'")
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
})
