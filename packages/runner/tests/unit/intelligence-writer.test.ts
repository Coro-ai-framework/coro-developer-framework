import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  commitAndPush,
  openProposalPr,
  parseRepoUrl,
  prepareRepoWriter,
  prepareTenantWriter,
} from '../../src/intelligence/writer'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as import('pino').Logger
}

interface GitMockOptions {
  defaultBranch?: string | null
  remoteHeads?: string[]
  remoteUrl?: string
  /** Files reported as modified after `add` — used to drive the empty-diff path. */
  emptyDiff?: boolean
  branchesLocal?: string[]
  failClone?: boolean
  failPush?: boolean
}

function makeGitMock(opts: GitMockOptions = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = []

  const initialHeads =
    opts.remoteHeads !== undefined ? [...opts.remoteHeads] : ['main']

  /** Mutable remote heads (`for-each-ref`); bootstrap `push` can add names. */
  let simulatedRemoteHeads = [...initialHeads]

  const clone = vi.fn(async (...args: unknown[]) => {
    calls.push({ method: 'clone', args })
    if (opts.failClone) throw new Error('clone failed')
  })
  const fetch = vi.fn(async (...args: unknown[]) => {
    calls.push({ method: 'fetch', args })
  })
  const checkout = vi.fn(async (...args: unknown[]) => { calls.push({ method: 'checkout', args }) })
  const reset = vi.fn(async (...args: unknown[]) => { calls.push({ method: 'reset', args }) })
  const add = vi.fn(async (...args: unknown[]) => { calls.push({ method: 'add', args }) })
  const commit = vi.fn(async (...args: unknown[]) => {
    calls.push({ method: 'commit', args })
    return { commit: 'abc123' }
  })
  const push = vi.fn(async (...args: unknown[]) => {
    calls.push({ method: 'push', args })
    if (opts.failPush) throw new Error('push failed')
    const r0 = args[0]
    const r1 = args[1]
    if (r0 === 'origin' && typeof r1 === 'string' && !simulatedRemoteHeads.includes(r1)) {
      simulatedRemoteHeads.push(r1)
      simulatedRemoteHeads.sort()
    }
  })
  const branchLocal = vi.fn(async () => ({ all: opts.branchesLocal ?? [], current: 'main' }))
  const status = vi.fn(async () => ({
    staged: opts.emptyDiff ? [] : ['file1'],
    created: [],
    modified: opts.emptyDiff ? [] : ['file1'],
    deleted: [],
  }))
  const getConfig = vi.fn(async () => ({ value: opts.remoteUrl ?? 'git@github.com:acme/intel.git' }))
  const raw = vi.fn(async (cmd: string[]) => {
    if (cmd[0] === 'for-each-ref') {
      if (simulatedRemoteHeads.length === 0) return ''
      return simulatedRemoteHeads.map(h => `origin/${h}`).join('\n') + '\n'
    }
    if (cmd[0] === 'symbolic-ref' && cmd.includes('refs/remotes/origin/HEAD')) {
      if (opts.defaultBranch === null) throw new Error('no symbolic ref')
      const branch = opts.defaultBranch ?? simulatedRemoteHeads[0] ?? 'main'
      return `origin/${branch}\n`
    }
    if (cmd[0] === 'checkout' && cmd[1] === '--orphan') {
      return ''
    }
    return ''
  })

  const factory = (_cwd: string) => ({
    clone,
    fetch,
    checkout,
    reset,
    add,
    commit,
    push,
    branchLocal,
    status,
    getConfig,
    raw,
  } as unknown as import('simple-git').SimpleGit)

  return {
    factory,
    clone,
    fetch,
    checkout,
    reset,
    add,
    commit,
    push,
    branchLocal,
    status,
    getConfig,
    raw,
    calls,
  }
}

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'coro-writer-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

// ── parseRepoUrl ─────────────────────────────────────────────────────────────

describe('parseRepoUrl', () => {
  it('parses HTTPS GitHub URLs', () => {
    expect(parseRepoUrl('https://github.com/acme/intel.git')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repoSlug: 'intel',
    })
  })

  it('parses HTTPS URLs without .git suffix', () => {
    expect(parseRepoUrl('https://github.com/acme/intel')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repoSlug: 'intel',
    })
  })

  it('strips embedded credentials from HTTPS URLs', () => {
    expect(parseRepoUrl('https://user:tok@github.com/acme/intel.git')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repoSlug: 'intel',
    })
  })

  it('parses SSH URLs', () => {
    expect(parseRepoUrl('git@github.com:acme/intel.git')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repoSlug: 'intel',
    })
  })

  it('parses SSH URLs without .git suffix', () => {
    expect(parseRepoUrl('git@bitbucket.org:acme/intel')).toEqual({
      host: 'bitbucket.org',
      owner: 'acme',
      repoSlug: 'intel',
    })
  })

  it('returns null for empty input', () => {
    expect(parseRepoUrl('')).toBeNull()
  })

  it('returns null for malformed input', () => {
    expect(parseRepoUrl('not a url')).toBeNull()
  })
})

// ── prepareTenantWriter ──────────────────────────────────────────────────────

describe('prepareTenantWriter', () => {
  it('clones the tenant overlay on first call', async () => {
    const writerCacheRoot = path.join(root, 'writers')
    const logger = makeLogger()
    const git = makeGitMock({ branchesLocal: ['main'] })

    const result = await prepareTenantWriter({
      url: 'git@github.com:acme/intel.git',
      ref: 'main',
      tenantId: 'team-acme',
      writerCacheRoot,
      logger,
      gitFactory: git.factory,
    })

    expect(result.dir).toBe(path.join(writerCacheRoot, 'team-acme', 'tenant'))
    expect(result.baseRef).toBe('main')
    expect(result.remoteUrl).toBe('git@github.com:acme/intel.git')
    expect(git.clone).toHaveBeenCalledWith(
      'git@github.com:acme/intel.git',
      path.join(writerCacheRoot, 'team-acme', 'tenant'),
    )
    expect(git.fetch).toHaveBeenCalledWith('origin')
    // No --depth or --single-branch — full clone for branch creation.
    const cloneArgs = git.clone.mock.calls[0]
    expect(cloneArgs).toHaveLength(2)
  })

  it('does not re-clone when the cache already has a .git dir', async () => {
    const writerCacheRoot = path.join(root, 'writers')
    const dir = path.join(writerCacheRoot, 'team-acme', 'tenant')
    await fs.mkdir(path.join(dir, '.git'), { recursive: true })

    const logger = makeLogger()
    const git = makeGitMock({ branchesLocal: ['main'] })

    const result = await prepareTenantWriter({
      url: 'git@github.com:acme/intel.git',
      tenantId: 'team-acme',
      writerCacheRoot,
      logger,
      gitFactory: git.factory,
    })

    expect(result.dir).toBe(dir)
    expect(git.clone).not.toHaveBeenCalled()
    expect(git.fetch).toHaveBeenCalledWith('origin')
    expect(git.reset).toHaveBeenCalledWith(['--hard', 'origin/main'])
  })

  it('creates a tracking branch when local does not have ref', async () => {
    const writerCacheRoot = path.join(root, 'writers')
    const dir = path.join(writerCacheRoot, 'team-acme', 'tenant')
    await fs.mkdir(path.join(dir, '.git'), { recursive: true })

    const logger = makeLogger()
    const git = makeGitMock({ branchesLocal: [], remoteHeads: ['develop'] })

    await prepareTenantWriter({
      url: 'git@github.com:acme/intel.git',
      ref: 'develop',
      tenantId: 'team-acme',
      writerCacheRoot,
      logger,
      gitFactory: git.factory,
    })

    expect(git.checkout).toHaveBeenCalledWith(['-b', 'develop', 'origin/develop'])
  })

  it('throws when url is missing', async () => {
    await expect(
      prepareTenantWriter({
        url: '',
        tenantId: 'team-acme',
        writerCacheRoot: path.join(root, 'writers'),
        logger: makeLogger(),
      }),
    ).rejects.toThrow('url is required')
  })

  it('throws when tenantId is missing', async () => {
    await expect(
      prepareTenantWriter({
        url: 'git@github.com:acme/intel.git',
        tenantId: '',
        writerCacheRoot: path.join(root, 'writers'),
        logger: makeLogger(),
      }),
    ).rejects.toThrow('tenantId is required')
  })

  it('uses master when origin has no main and ref is omitted', async () => {
    const writerCacheRoot = path.join(root, 'writers')
    const logger = makeLogger()
    const git = makeGitMock({
      branchesLocal: [],
      remoteHeads: ['master'],
      defaultBranch: 'master',
    })

    const result = await prepareTenantWriter({
      url: 'git@github.com:acme/intel.git',
      tenantId: 'team-legacy',
      writerCacheRoot,
      logger,
      gitFactory: git.factory,
    })

    expect(result.baseRef).toBe('master')
    expect(git.reset).toHaveBeenCalledWith(['--hard', 'origin/master'])
  })

  it('bootstraps an empty remote with an initial commit on main', async () => {
    const writerCacheRoot = path.join(root, 'writers')
    const tenantDir = path.join(writerCacheRoot, 'solo-empty', 'tenant')
    await fs.mkdir(path.join(tenantDir, '.git'), { recursive: true })

    const logger = makeLogger()
    const git = makeGitMock({ branchesLocal: [], remoteHeads: [] })

    const result = await prepareTenantWriter({
      url: 'git@github.com:acme/empty-intel.git',
      tenantId: 'solo-empty',
      writerCacheRoot,
      logger,
      gitFactory: git.factory,
    })

    expect(result.baseRef).toBe('main')
    expect(git.clone).not.toHaveBeenCalled()
    expect(git.raw).toHaveBeenCalledWith(['checkout', '--orphan', 'main'])
    expect(git.commit).toHaveBeenCalledWith('chore(coro): bootstrap empty tenant intelligence repository')
    expect(git.push).toHaveBeenCalledWith('origin', 'main', ['--set-upstream'])
    const gitkeep = path.join(tenantDir, '.gitkeep')
    expect(await fs.readFile(gitkeep, 'utf-8')).toBe('')
  })

  it('throws when an explicit ref is not on origin', async () => {
    const writerCacheRoot = path.join(root, 'writers')
    await fs.mkdir(path.join(writerCacheRoot, 'team-x', 'tenant', '.git'), { recursive: true })

    const git = makeGitMock({ branchesLocal: [], remoteHeads: ['develop'] })

    await expect(
      prepareTenantWriter({
        url: 'git@github.com:acme/intel.git',
        ref: 'main',
        tenantId: 'team-x',
        writerCacheRoot,
        logger: makeLogger(),
        gitFactory: git.factory,
      }),
    ).rejects.toThrow('Tenant overlay ref "main" does not exist on origin')
  })
})

// ── prepareRepoWriter ────────────────────────────────────────────────────────

describe('prepareRepoWriter', () => {
  it('returns the existing repo dir + remote URL when the checkout is valid', async () => {
    const repo = path.join(root, 'my-repo')
    await fs.mkdir(path.join(repo, '.git'), { recursive: true })

    const git = makeGitMock({ remoteUrl: 'git@github.com:acme/my-repo.git', defaultBranch: 'main' })

    const result = await prepareRepoWriter({
      repoCheckoutDir: repo,
      logger: makeLogger(),
      gitFactory: git.factory,
    })

    expect(result.dir).toBe(repo)
    expect(result.remoteUrl).toBe('git@github.com:acme/my-repo.git')
    expect(result.baseRef).toBe('main')
  })

  it('detects a non-main default branch when origin/HEAD points elsewhere', async () => {
    const repo = path.join(root, 'my-repo')
    await fs.mkdir(path.join(repo, '.git'), { recursive: true })

    const git = makeGitMock({ remoteUrl: 'git@github.com:acme/my-repo.git', defaultBranch: 'master' })

    const result = await prepareRepoWriter({
      repoCheckoutDir: repo,
      logger: makeLogger(),
      gitFactory: git.factory,
    })
    expect(result.baseRef).toBe('master')
  })

  it('falls back to "main" when origin/HEAD is unreadable', async () => {
    const repo = path.join(root, 'my-repo')
    await fs.mkdir(path.join(repo, '.git'), { recursive: true })

    const git = makeGitMock({ remoteUrl: 'git@github.com:acme/my-repo.git', defaultBranch: null })

    const result = await prepareRepoWriter({
      repoCheckoutDir: repo,
      logger: makeLogger(),
      gitFactory: git.factory,
    })
    expect(result.baseRef).toBe('main')
  })

  it('throws when the dir is not a git checkout', async () => {
    const repo = path.join(root, 'plain-dir')
    await fs.mkdir(repo, { recursive: true })

    await expect(
      prepareRepoWriter({
        repoCheckoutDir: repo,
        logger: makeLogger(),
        gitFactory: makeGitMock().factory,
      }),
    ).rejects.toThrow('is not a git checkout')
  })

  it('throws when the checkout has no origin remote', async () => {
    const repo = path.join(root, 'no-remote')
    await fs.mkdir(path.join(repo, '.git'), { recursive: true })

    const git = makeGitMock({ remoteUrl: '' })
    await expect(
      prepareRepoWriter({
        repoCheckoutDir: repo,
        logger: makeLogger(),
        gitFactory: git.factory,
      }),
    ).rejects.toThrow('no origin remote')
  })
})

// ── commitAndPush ────────────────────────────────────────────────────────────

describe('commitAndPush', () => {
  it('writes files, commits, and pushes a fresh feature branch', async () => {
    const dir = path.join(root, 'work')
    await fs.mkdir(dir, { recursive: true })

    const git = makeGitMock({ branchesLocal: ['main'] })

    await commitAndPush({
      dir,
      branch: 'coro/proposal/test-job-1-tenant',
      baseRef: 'main',
      files: [
        { path: 'memory/notes.md', content: 'a learning' },
        { path: 'agents/coder.md', content: '# Coder\nUpdated' },
      ],
      commitMessage: 'Coro proposal: test',
      logger: makeLogger(),
      gitFactory: git.factory,
    })

    // Files were written
    expect(await fs.readFile(path.join(dir, 'memory/notes.md'), 'utf-8')).toBe('a learning')
    expect(await fs.readFile(path.join(dir, 'agents/coder.md'), 'utf-8')).toBe('# Coder\nUpdated')

    // Branch created off main
    expect(git.checkout).toHaveBeenCalledWith('main')
    expect(git.checkout).toHaveBeenCalledWith(['-b', 'coro/proposal/test-job-1-tenant'])

    // Staged + committed + pushed
    expect(git.add).toHaveBeenCalledWith('.')
    expect(git.commit).toHaveBeenCalledWith('Coro proposal: test')
    expect(git.push).toHaveBeenCalledWith(
      'origin',
      'coro/proposal/test-job-1-tenant',
      ['--set-upstream'],
    )
  })

  it('refuses to commit onto a branch outside the coro/proposal namespace', async () => {
    await expect(
      commitAndPush({
        dir: root,
        branch: 'main',
        baseRef: 'main',
        files: [{ path: 'x.md', content: 'x' }],
        commitMessage: 'm',
        logger: makeLogger(),
        gitFactory: makeGitMock().factory,
      }),
    ).rejects.toThrow('coro/proposal/* namespace')
  })

  it('rejects file paths that escape the writer dir', async () => {
    const dir = path.join(root, 'work')
    await fs.mkdir(dir, { recursive: true })

    await expect(
      commitAndPush({
        dir,
        branch: 'coro/proposal/x',
        baseRef: 'main',
        files: [{ path: '../../etc/passwd', content: 'bad' }],
        commitMessage: 'm',
        logger: makeLogger(),
        gitFactory: makeGitMock({ branchesLocal: ['main'] }).factory,
      }),
    ).rejects.toThrow('escapes the writer dir')
  })

  it('throws a clear error when the proposal would produce an empty diff', async () => {
    const dir = path.join(root, 'work')
    await fs.mkdir(dir, { recursive: true })

    const git = makeGitMock({ branchesLocal: ['main'], emptyDiff: true })

    await expect(
      commitAndPush({
        dir,
        branch: 'coro/proposal/empty',
        baseRef: 'main',
        files: [{ path: 'memory/notes.md', content: 'identical' }],
        commitMessage: 'noop',
        logger: makeLogger(),
        gitFactory: git.factory,
      }),
    ).rejects.toThrow('empty diff')

    expect(git.commit).not.toHaveBeenCalled()
    expect(git.push).not.toHaveBeenCalled()
  })

  it('hard-resets an existing local branch off baseRef before re-using it', async () => {
    const dir = path.join(root, 'work')
    await fs.mkdir(dir, { recursive: true })

    const git = makeGitMock({ branchesLocal: ['main', 'coro/proposal/already-there'] })

    await commitAndPush({
      dir,
      branch: 'coro/proposal/already-there',
      baseRef: 'main',
      files: [{ path: 'memory/notes.md', content: 'fresh' }],
      commitMessage: 'reset',
      logger: makeLogger(),
      gitFactory: git.factory,
    })

    // Both `main` and the existing feature branch get hard-reset to origin/main
    expect(git.reset).toHaveBeenCalledWith(['--hard', 'origin/main'])
  })
})

// ── openProposalPr ───────────────────────────────────────────────────────────

describe('openProposalPr', () => {
  function makeBb(): import('../../src/clients/bitbucket').BitBucketClient {
    return {
      createPr: vi.fn(async (opts: import('../../src/clients/bitbucket').CreatePrOptions) => ({
        id: 42,
        title: opts.title,
        description: opts.description ?? '',
        state: 'OPEN',
        source: { branch: { name: opts.sourceBranch } },
        destination: { branch: { name: opts.targetBranch ?? 'main' } },
        author: { display_name: 'bot' },
        created_on: 'now',
        updated_on: 'now',
        links: { html: { href: `https://bitbucket.org/acme/intel/pull-requests/${42}` } },
      })),
    } as unknown as import('../../src/clients/bitbucket').BitBucketClient
  }

  function makeGh(): import('../../src/clients/github').GitHubClient {
    return {
      createPr: vi.fn(async (opts: import('../../src/clients/github').CreatePrOptions) => ({
        id: 7,
        title: opts.title,
        description: opts.description ?? '',
        state: 'OPEN',
        source: { branch: { name: opts.sourceBranch } },
        destination: { branch: { name: opts.targetBranch ?? 'main' } },
        author: { display_name: 'bot' },
        created_on: 'now',
        updated_on: 'now',
        links: { html: { href: `https://github.com/acme/intel/pull/7` } },
      })),
    } as unknown as import('../../src/clients/github').GitHubClient
  }

  it('routes github URLs to ghClient', async () => {
    const ghClient = makeGh()
    const bbCoder = makeBb()

    const result = await openProposalPr({
      remoteUrl: 'git@github.com:acme/intel.git',
      branch: 'coro/proposal/x',
      baseRef: 'main',
      title: 't',
      body: 'b',
      bbCoder,
      ghClient,
      logger: makeLogger(),
    })

    expect(result.provider).toBe('github')
    expect(result.id).toBe(7)
    expect(ghClient.createPr).toHaveBeenCalledWith(expect.objectContaining({
      repoSlug: 'intel',
      sourceBranch: 'coro/proposal/x',
      targetBranch: 'main',
    }))
    expect(bbCoder.createPr).not.toHaveBeenCalled()
  })

  it('routes bitbucket URLs to bbCoder', async () => {
    const ghClient = makeGh()
    const bbCoder = makeBb()

    const result = await openProposalPr({
      remoteUrl: 'https://bitbucket.org/acme/intel.git',
      branch: 'coro/proposal/x',
      baseRef: 'main',
      title: 't',
      body: 'b',
      bbCoder,
      ghClient,
      logger: makeLogger(),
    })

    expect(result.provider).toBe('bitbucket')
    expect(result.id).toBe(42)
    expect(bbCoder.createPr).toHaveBeenCalled()
    expect(ghClient.createPr).not.toHaveBeenCalled()
  })

  it('throws when host is unsupported', async () => {
    await expect(
      openProposalPr({
        remoteUrl: 'git@gitlab.com:acme/intel.git',
        branch: 'coro/proposal/x',
        baseRef: 'main',
        title: 't',
        body: 'b',
        bbCoder: makeBb(),
        ghClient: makeGh(),
        logger: makeLogger(),
      }),
    ).rejects.toThrow('unsupported provider host')
  })

  it('throws when the URL is a GitHub repo but ghClient is null', async () => {
    await expect(
      openProposalPr({
        remoteUrl: 'git@github.com:acme/intel.git',
        branch: 'coro/proposal/x',
        baseRef: 'main',
        title: 't',
        body: 'b',
        bbCoder: makeBb(),
        ghClient: null,
        logger: makeLogger(),
      }),
    ).rejects.toThrow('no GitHub client is configured')
  })

  it('throws when the URL cannot be parsed', async () => {
    await expect(
      openProposalPr({
        remoteUrl: '',
        branch: 'coro/proposal/x',
        baseRef: 'main',
        title: 't',
        body: 'b',
        bbCoder: makeBb(),
        ghClient: makeGh(),
        logger: makeLogger(),
      }),
    ).rejects.toThrow('cannot parse repo URL')
  })

  it('forwards reviewerUsernames when supplied', async () => {
    const ghClient = makeGh()
    await openProposalPr({
      remoteUrl: 'https://github.com/acme/intel.git',
      branch: 'coro/proposal/x',
      baseRef: 'main',
      title: 't',
      body: 'b',
      reviewerUsernames: ['alice', 'bob'],
      bbCoder: makeBb(),
      ghClient,
      logger: makeLogger(),
    })
    expect(ghClient.createPr).toHaveBeenCalledWith(expect.objectContaining({
      reviewerUsernames: ['alice', 'bob'],
    }))
  })
})
