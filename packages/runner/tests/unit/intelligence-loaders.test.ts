import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  loadCloudBlobOverlay,
  loadGitRemoteOverlay,
  loadLocalDirOverlay,
  loadRepoOverlay,
} from '../../src/intelligence/loaders'

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as import('pino').Logger
}

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'coro-loaders-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

// ── localDir ───────────────────────────────────────────────────────────────

describe('loadLocalDirOverlay', () => {
  it('returns the path when the directory exists', async () => {
    const dir = path.join(root, 'overlay')
    await fs.mkdir(dir, { recursive: true })
    const logger = makeLogger()

    const result = await loadLocalDirOverlay({ path: dir, logger })
    expect(result).toBe(dir)
  })

  it('warns and returns null when the path does not exist', async () => {
    const logger = makeLogger()
    const result = await loadLocalDirOverlay({ path: path.join(root, 'missing'), logger })
    expect(result).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('warns and returns null when the path is a file (not a directory)', async () => {
    const file = path.join(root, 'file.txt')
    await fs.writeFile(file, 'not a dir')
    const logger = makeLogger()
    const result = await loadLocalDirOverlay({ path: file, logger })
    expect(result).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('warns and returns null when the path is empty', async () => {
    const logger = makeLogger()
    const result = await loadLocalDirOverlay({ path: '', logger })
    expect(result).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
  })
})

// ── gitRemote ───────────────────────────────────────────────────────────────
//
// The git client is injected via `gitFactory` so tests do not actually
// reach the network. We assert the expected sequence of git operations
// for both first-fetch and subsequent-pull paths.

describe('loadGitRemoteOverlay', () => {
  function makeGitMock(opts: { failClone?: boolean } = {}) {
    const clone = vi.fn(async () => {
      if (opts.failClone) throw new Error('boom')
    })
    const fetch = vi.fn(async () => undefined)
    const reset = vi.fn(async () => undefined)
    return {
      clone,
      fetch,
      reset,
      // simple-git's chainable API — return the same mock for chaining
      // calls like `git(cwd).clone(...)`.
      asSimpleGit: () => ({ clone, fetch, reset }) as unknown as import('simple-git').SimpleGit,
    }
  }

  it('clones into the cache dir on first fetch and returns the cache path', async () => {
    const cacheRoot = path.join(root, 'cache')
    const logger = makeLogger()
    const git = makeGitMock()

    const result = await loadGitRemoteOverlay({
      url: 'git@example.com:overlay.git',
      ref: 'main',
      tenantId: 'team-abc',
      cacheRoot,
      logger,
      gitFactory: git.asSimpleGit,
    })

    expect(result).toBe(path.join(cacheRoot, 'team-abc'))
    expect(git.clone).toHaveBeenCalledWith(
      'git@example.com:overlay.git',
      path.join(cacheRoot, 'team-abc'),
      expect.arrayContaining(['--depth', '1', '--branch', 'main', '--single-branch']),
    )
    expect(git.fetch).not.toHaveBeenCalled()
  })

  it('fetches + resets on subsequent calls when the cache already has a .git dir', async () => {
    const cacheRoot = path.join(root, 'cache')
    const cacheDir = path.join(cacheRoot, 'team-abc')
    await fs.mkdir(path.join(cacheDir, '.git'), { recursive: true })

    const logger = makeLogger()
    const git = makeGitMock()
    const result = await loadGitRemoteOverlay({
      url: 'git@example.com:overlay.git',
      ref: 'develop',
      tenantId: 'team-abc',
      cacheRoot,
      logger,
      gitFactory: git.asSimpleGit,
    })

    expect(result).toBe(cacheDir)
    expect(git.clone).not.toHaveBeenCalled()
    expect(git.fetch).toHaveBeenCalledWith('origin', 'develop', expect.arrayContaining(['--depth', '1']))
    expect(git.reset).toHaveBeenCalledWith(expect.arrayContaining(['--hard', 'origin/develop']))
  })

  it('defaults the ref to main when omitted', async () => {
    const cacheRoot = path.join(root, 'cache')
    const logger = makeLogger()
    const git = makeGitMock()

    await loadGitRemoteOverlay({
      url: 'git@example.com:overlay.git',
      tenantId: 'team-default-ref',
      cacheRoot,
      logger,
      gitFactory: git.asSimpleGit,
    })

    expect(git.clone).toHaveBeenCalledWith(
      'git@example.com:overlay.git',
      expect.any(String),
      expect.arrayContaining(['--branch', 'main']),
    )
  })

  it('warns and returns null when url is missing', async () => {
    const logger = makeLogger()
    const result = await loadGitRemoteOverlay({
      url: '',
      tenantId: 'team-x',
      cacheRoot: path.join(root, 'cache'),
      logger,
    })
    expect(result).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('warns and returns null when tenantId is missing', async () => {
    const logger = makeLogger()
    const result = await loadGitRemoteOverlay({
      url: 'git@example.com:o.git',
      tenantId: '',
      cacheRoot: path.join(root, 'cache'),
      logger,
    })
    expect(result).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('returns null and warns (does not throw) when git clone fails', async () => {
    const logger = makeLogger()
    const git = makeGitMock({ failClone: true })

    const result = await loadGitRemoteOverlay({
      url: 'git@example.com:bad.git',
      tenantId: 'team-broken',
      cacheRoot: path.join(root, 'cache'),
      logger,
      gitFactory: git.asSimpleGit,
    })

    expect(result).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
  })
})

// ── cloudBlob (Phase 5 stub) ───────────────────────────────────────────────

describe('loadCloudBlobOverlay', () => {
  it('warns and returns null (Phase 5 stub)', async () => {
    const logger = makeLogger()
    const result = await loadCloudBlobOverlay({ key: 'tenant/abc/v1', tenantId: 'team-abc', logger })
    expect(result).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
  })
})

// ── repo .coro/ overlay ────────────────────────────────────────────────────

describe('loadRepoOverlay', () => {
  it('returns the .coro path when the repo has one', async () => {
    const repo = path.join(root, 'my-repo')
    await fs.mkdir(path.join(repo, '.coro'), { recursive: true })
    const logger = makeLogger()

    const result = await loadRepoOverlay({ repoCheckoutDir: repo, logger })
    expect(result).toBe(path.join(repo, '.coro'))
  })

  it('returns null when the repo has no .coro directory', async () => {
    const repo = path.join(root, 'no-coro')
    await fs.mkdir(repo, { recursive: true })
    const logger = makeLogger()

    const result = await loadRepoOverlay({ repoCheckoutDir: repo, logger })
    expect(result).toBeNull()
    // No warning here — absence of .coro is a normal state, not a misconfig.
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('returns null when the repo checkout dir itself does not exist', async () => {
    const logger = makeLogger()
    const result = await loadRepoOverlay({
      repoCheckoutDir: path.join(root, 'does-not-exist'),
      logger,
    })
    expect(result).toBeNull()
  })

  it('returns null and warns when .coro exists but is a file', async () => {
    const repo = path.join(root, 'odd-repo')
    await fs.mkdir(repo, { recursive: true })
    await fs.writeFile(path.join(repo, '.coro'), 'not a dir')
    const logger = makeLogger()

    const result = await loadRepoOverlay({ repoCheckoutDir: repo, logger })
    expect(result).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('intentionally does NOT touch the repo .claude directory', async () => {
    // Documents the contract via a test: repo's .claude/ is left for
    // Claude Code's native settingSources: ['project'] loader to read at
    // the SDK's cwd. The overlay system MUST not return or copy it.
    const repo = path.join(root, 'repo-with-claude')
    await fs.mkdir(path.join(repo, '.claude'), { recursive: true })
    await fs.writeFile(path.join(repo, '.claude', 'CLAUDE.md'), '# Repo CLAUDE')
    const logger = makeLogger()

    const result = await loadRepoOverlay({ repoCheckoutDir: repo, logger })
    // No .coro here, so nothing to load — and crucially nothing about
    // .claude in the result.
    expect(result).toBeNull()
  })

  it('returns null when repoCheckoutDir is empty', async () => {
    const logger = makeLogger()
    const result = await loadRepoOverlay({ repoCheckoutDir: '', logger })
    expect(result).toBeNull()
  })
})
