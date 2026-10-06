import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import type { Logger } from 'pino'
import type { SimpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  UPSTREAM_SOURCE_STAMP,
  UPSTREAM_SOURCE_SUBDIR,
  materialiseSourceSnapshot,
  materialiseUpstreamSource,
} from '../../src/tools/upstream-source'

const COMMIT = '9f1c0ddeadbeef0000000000000000000000abcd'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

let jobWorkingDir: string
let absDir: string

/**
 * Stands in for simple-git: `clone` materialises a tree that looks like a
 * fresh checkout (a file plus a `.git`), so the assertions about what
 * survives the clone are about real directory contents.
 */
function makeGit(over: {
  clone?: (url: string, dir: string, opts?: string[]) => Promise<void>
  revparse?: (args: string[]) => Promise<string>
} = {}) {
  const clone = vi.fn(over.clone ?? (async (_url: string, dir: string) => {
    await fs.mkdir(path.join(dir, '.git'), { recursive: true })
    await fs.mkdir(path.join(dir, 'packages/runner/src'), { recursive: true })
    await fs.writeFile(path.join(dir, 'packages/runner/src/index.ts'), 'export {}\n', 'utf-8')
  }))
  const revparse = vi.fn(over.revparse ?? (async () => `${COMMIT}\n`))
  return {
    clone,
    revparse,
    factory: (_cwd: string) => ({ clone, revparse }) as unknown as SimpleGit,
  }
}

function args(git: ReturnType<typeof makeGit>, over: Record<string, unknown> = {}) {
  return {
    cloneUrl: 'https://github.com/coro-ai-framework/coro.git',
    repo: 'coro-ai-framework/coro',
    ref: 'main',
    jobWorkingDir,
    logger,
    gitFactory: git.factory,
    ...over,
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  jobWorkingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coro-upstream-src-'))
  absDir = path.join(jobWorkingDir, UPSTREAM_SOURCE_SUBDIR)
})

afterEach(async () => {
  await fs.rm(jobWorkingDir, { recursive: true, force: true })
})

describe('materialiseUpstreamSource', () => {
  it('clones the ref shallowly into the job working directory', async () => {
    const git = makeGit()
    const snapshot = await materialiseUpstreamSource(args(git))

    const [url, dir, opts] = git.clone.mock.calls[0] as [string, string, string[]]
    expect(url).toBe('https://github.com/coro-ai-framework/coro.git')
    expect(dir).toBe(absDir)
    expect(opts).toEqual(['--depth', '1', '--single-branch', '--branch', 'main'])

    expect(snapshot).toMatchObject({
      dir: UPSTREAM_SOURCE_SUBDIR,
      absDir,
      repo: 'coro-ai-framework/coro',
      ref: 'main',
      commit: COMMIT,
      cloned: true,
    })
  })

  it('leaves a source tree the agent can read but nothing can push from', async () => {
    const git = makeGit()
    await materialiseUpstreamSource(args(git))

    // The revision is read first, then `.git` goes: a tree with no git
    // metadata cannot be branched or pushed, and the workspace/diff
    // machinery will not mistake it for the job's target repo checkout.
    expect(git.revparse).toHaveBeenCalledWith(['HEAD'])
    await expect(fs.stat(path.join(absDir, '.git'))).rejects.toThrow()
    await expect(fs.stat(path.join(absDir, 'packages/runner/src/index.ts'))).resolves.toBeTruthy()
  })

  it('records the revision on disk, since `.git` is no longer there to ask', async () => {
    const git = makeGit()
    await materialiseUpstreamSource(args(git))

    const stamp = JSON.parse(await fs.readFile(path.join(absDir, UPSTREAM_SOURCE_STAMP), 'utf-8'))
    expect(stamp).toMatchObject({ repo: 'coro-ai-framework/coro', ref: 'main', commit: COMMIT })
    expect(stamp.at).toBeTruthy()
  })

  it('reuses an existing snapshot instead of re-cloning mid-run', async () => {
    const first = makeGit()
    await materialiseUpstreamSource(args(first))

    const second = makeGit()
    const snapshot = await materialiseUpstreamSource(args(second))

    // Two findings verified against two different revisions would be worse
    // than a snapshot that is a few minutes old.
    expect(second.clone).not.toHaveBeenCalled()
    expect(snapshot).toMatchObject({ cloned: false, commit: COMMIT })
  })

  it('replaces a snapshot taken from a different ref', async () => {
    const first = makeGit()
    await materialiseUpstreamSource(args(first))

    const second = makeGit()
    const snapshot = await materialiseUpstreamSource(args(second, { ref: 'release-2' }))

    expect(second.clone).toHaveBeenCalled()
    expect(snapshot).toMatchObject({ ref: 'release-2', cloned: true })
  })

  it('re-clones when the stamp is missing or unreadable', async () => {
    const first = makeGit()
    await materialiseUpstreamSource(args(first))
    await fs.writeFile(path.join(absDir, UPSTREAM_SOURCE_STAMP), 'not json', 'utf-8')

    const second = makeGit()
    await materialiseUpstreamSource(args(second))
    expect(second.clone).toHaveBeenCalled()
  })

  it('leaves nothing behind when the clone fails', async () => {
    // A partial tree reads as a complete snapshot to the next caller, and
    // would be grepped as if upstream simply did not contain the file.
    const git = makeGit({
      clone: async (_url, dir) => {
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, 'partial.ts'), '', 'utf-8')
        throw new Error('fatal: could not read from remote repository')
      },
    })

    await expect(materialiseUpstreamSource(args(git))).rejects.toThrow(/remote repository/)
    await expect(fs.stat(absDir)).rejects.toThrow()
  })
})

describe('materialiseSourceSnapshot', () => {
  function branchRevparse(args: string[]): Promise<string> {
    return Promise.resolve(args[0] === '--abbrev-ref' ? 'main\n' : `${COMMIT}\n`)
  }

  it('clones the remote default branch when no ref is given and records the resolved name', async () => {
    const git = makeGit({ revparse: branchRevparse })
    const dest = path.join(jobWorkingDir, 'repos', 'acme_api@default')
    const snapshot = await materialiseSourceSnapshot({
      cloneUrl: 'https://github.com/acme/api.git',
      repo: 'acme/api',
      destDir: dest,
      logger,
      gitFactory: git.factory,
    })

    const opts = (git.clone.mock.calls[0] as [string, string, string[]])[2]
    expect(opts).toEqual(['--depth', '1', '--single-branch'])
    expect(git.revparse).toHaveBeenCalledWith(['--abbrev-ref', 'HEAD'])
    expect(snapshot).toMatchObject({
      ref: 'main',
      requestedRef: 'default',
      absDir: dest,
      cloned: true,
      commit: COMMIT,
    })
    const stamp = JSON.parse(await fs.readFile(path.join(dest, UPSTREAM_SOURCE_STAMP), 'utf-8'))
    expect(stamp).toMatchObject({ ref: 'main', requestedRef: 'default', commit: COMMIT })
    await expect(fs.stat(path.join(dest, '.git'))).rejects.toThrow()
  })

  it('writes to the requested directory', async () => {
    const git = makeGit()
    const dest = path.join(jobWorkingDir, 'custom', 'tree')
    const snapshot = await materialiseSourceSnapshot({
      cloneUrl: 'https://github.com/acme/api.git',
      repo: 'acme/api',
      ref: 'k8s-staging',
      destDir: dest,
      logger,
      gitFactory: git.factory,
    })
    expect(snapshot.absDir).toBe(dest)
    expect((git.clone.mock.calls[0] as [string, string, string[]])[2]).toEqual([
      '--depth', '1', '--single-branch', '--branch', 'k8s-staging',
    ])
    await expect(fs.stat(path.join(jobWorkingDir, UPSTREAM_SOURCE_SUBDIR))).rejects.toThrow()
    await expect(fs.stat(path.join(dest, 'packages/runner/src/index.ts'))).resolves.toBeTruthy()
  })

  it('does not treat a default-branch snapshot and an explicit ref as the same request', async () => {
    const dest = path.join(jobWorkingDir, 'snap')
    const base = {
      cloneUrl: 'https://github.com/acme/api.git',
      repo: 'acme/api',
      destDir: dest,
      logger,
    }
    const first = makeGit({ revparse: branchRevparse })
    await materialiseSourceSnapshot({ ...base, gitFactory: first.factory })

    const again = makeGit({ revparse: branchRevparse })
    const reused = await materialiseSourceSnapshot({ ...base, gitFactory: again.factory })
    expect(again.clone).not.toHaveBeenCalled()
    expect(reused).toMatchObject({ cloned: false, ref: 'main', requestedRef: 'default' })

    const explicit = makeGit()
    const replaced = await materialiseSourceSnapshot({ ...base, ref: 'main', gitFactory: explicit.factory })
    expect(explicit.clone).toHaveBeenCalled()
    expect(replaced).toMatchObject({ ref: 'main', requestedRef: 'main', cloned: true })

    const backToDefault = makeGit({ revparse: branchRevparse })
    const recloned = await materialiseSourceSnapshot({ ...base, gitFactory: backToDefault.factory })
    expect(backToDefault.clone).toHaveBeenCalled()
    expect(recloned).toMatchObject({ requestedRef: 'default', cloned: true })
  })
})
