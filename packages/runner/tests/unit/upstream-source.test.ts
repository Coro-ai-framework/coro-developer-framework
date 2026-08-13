import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import type { Logger } from 'pino'
import type { SimpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  UPSTREAM_SOURCE_STAMP,
  UPSTREAM_SOURCE_SUBDIR,
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
function makeGit(over: { clone?: (url: string, dir: string, opts?: string[]) => Promise<void> } = {}) {
  const clone = vi.fn(over.clone ?? (async (_url: string, dir: string) => {
    await fs.mkdir(path.join(dir, '.git'), { recursive: true })
    await fs.mkdir(path.join(dir, 'packages/runner/src'), { recursive: true })
    await fs.writeFile(path.join(dir, 'packages/runner/src/index.ts'), 'export {}\n', 'utf-8')
  }))
  const revparse = vi.fn(async () => `${COMMIT}\n`)
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
