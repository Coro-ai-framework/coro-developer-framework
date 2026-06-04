import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { simpleGit } from 'simple-git'

import { computeJobDiff, emptyJobDiff, defaultBaseBranch } from '../../src/jobs/job-diff'
import type { Job } from '@coro-ai/cloud-protocol'

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'coro-jobdiff-'))
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

async function initRepo(dir: string) {
  await fs.mkdir(dir, { recursive: true })
  const git = simpleGit({ baseDir: dir })
  await git.init(['--initial-branch=main'])
  await git.addConfig('user.email', 'test@coro.dev')
  await git.addConfig('user.name', 'Coro Test')
  await git.addConfig('commit.gpgsign', 'false')
  return git
}

describe('computeJobDiff', () => {
  it('returns available:false when the directory is not a git repo', async () => {
    const diff = await computeJobDiff({ repoDir: path.join(tmp, 'nope') })
    expect(diff.available).toBe(false)
    expect(diff.files).toEqual([])
    expect(diff.patch).toBe('')
  })

  it('returns committed + uncommitted changes against the merge base', async () => {
    const repo = path.join(tmp, 'repo')
    const git = await initRepo(repo)

    // Base commit on main.
    await fs.writeFile(path.join(repo, 'keep.txt'), 'unchanged\n')
    await fs.writeFile(path.join(repo, 'mod.txt'), 'line1\nline2\n')
    await git.add('.')
    await git.commit('base')

    // Work-item branch with a committed change + a new committed file.
    await git.checkoutLocalBranch('feature/x')
    await fs.writeFile(path.join(repo, 'mod.txt'), 'line1\nline2-changed\n')
    await fs.writeFile(path.join(repo, 'added.txt'), 'brand new\n')
    await git.add('.')
    await git.commit('feature work')

    // Plus an uncommitted edit in the working tree.
    await fs.writeFile(path.join(repo, 'mod.txt'), 'line1\nline2-changed-again\n')

    const diff = await computeJobDiff({ repoDir: repo, base: 'main' })

    expect(diff.available).toBe(true)
    const paths = diff.files.map(f => f.path).sort()
    expect(paths).toEqual(['added.txt', 'mod.txt'])
    expect(paths).not.toContain('keep.txt')
    expect(diff.stats.files).toBe(2)
    expect(diff.patch).toContain('added.txt')
    expect(diff.patch).toContain('line2-changed-again')
  })

  it('falls back to origin/<base> when the bare base name is absent', async () => {
    const repo = path.join(tmp, 'repo2')
    const git = await initRepo(repo)
    await fs.writeFile(path.join(repo, 'a.txt'), 'a\n')
    await git.add('.')
    await git.commit('base')
    await git.checkoutLocalBranch('feature/y')
    await fs.writeFile(path.join(repo, 'a.txt'), 'a-changed\n')
    await git.add('.')
    await git.commit('change')

    // A non-existent base resolves to an empty (but available) diff rather than throwing.
    const diff = await computeJobDiff({ repoDir: repo, base: 'does-not-exist' })
    expect(diff.available).toBe(true)
    expect(diff.files).toEqual([])
  })

  it('truncates an oversized patch but keeps the file summary complete', async () => {
    const repo = path.join(tmp, 'repo3')
    const git = await initRepo(repo)
    await fs.writeFile(path.join(repo, 'big.txt'), 'seed\n')
    await git.add('.')
    await git.commit('base')
    await git.checkoutLocalBranch('feature/big')
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')
    await fs.writeFile(path.join(repo, 'big.txt'), big)
    await git.add('.')
    await git.commit('big change')

    const diff = await computeJobDiff({ repoDir: repo, base: 'main', maxPatchBytes: 500 })
    expect(diff.truncated).toBe(true)
    expect(Buffer.byteLength(diff.patch, 'utf-8')).toBeLessThanOrEqual(500)
    expect(diff.stats.files).toBe(1)
    expect(diff.files[0].path).toBe('big.txt')
  })
})

describe('defaultBaseBranch', () => {
  const baseJob = { params: {} } as unknown as Job

  it('defaults to main', () => {
    expect(defaultBaseBranch(baseJob)).toBe('main')
  })

  it('prefers params.targetBranch', () => {
    const job = { params: { targetBranch: 'develop' } } as unknown as Job
    expect(defaultBaseBranch(job)).toBe('develop')
  })
})

describe('emptyJobDiff', () => {
  it('is unavailable and empty', () => {
    const diff = emptyJobDiff('trunk')
    expect(diff.available).toBe(false)
    expect(diff.base).toBe('trunk')
    expect(diff.files).toEqual([])
  })
})
