import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { simpleGit } from 'simple-git'

import { computeJobDiff, emptyJobDiff, defaultBaseBranch, resolveDiffBase } from '../../src/jobs/job-diff'
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

  it('excludes an already-merged work item by preferring origin/<base> (multi-work-item)', async () => {
    // Reproduces the sequential multi-work-item flow:
    //   WI1: branch from main, commit, PR merged *server-side* (origin/main advances).
    //   WI2: branch from the updated origin/main, commit.
    //   Local `main` stays stale at the original base (the runner never pulls it).
    // The Changes tab must show only WI2's file, not WI1's already-merged work.
    const repo = path.join(tmp, 'multi')
    const git = await initRepo(repo)

    // Base commit (M0) on local main.
    await fs.writeFile(path.join(repo, 'base.txt'), 'base\n')
    await git.add('.')
    await git.commit('M0 base')

    // WI1 branch + commit (c1). This is what gets merged on the remote.
    await git.checkoutLocalBranch('coro/wi1')
    await fs.writeFile(path.join(repo, 'wi1.txt'), 'work item one\n')
    await git.add('.')
    await git.commit('c1: work item 1')
    const wi1Tip = (await git.revparse(['HEAD'])).trim()

    // Simulate the server-side PR merge: origin/main now contains c1, while the
    // local `main` branch is left untouched (stale at M0).
    await git.raw(['update-ref', 'refs/remotes/origin/main', wi1Tip])

    // WI2 branch from the merged remote tip + commit (c2).
    await git.checkout(['-b', 'coro/wi2', 'origin/main'])
    await fs.writeFile(path.join(repo, 'wi2.txt'), 'work item two\n')
    await git.add('.')
    await git.commit('c2: work item 2')

    const diff = await computeJobDiff({ repoDir: repo, base: 'main' })

    expect(diff.available).toBe(true)
    expect(diff.base).toBe('origin/main') // remote-tracking ref preferred over stale local main
    const paths = diff.files.map(f => f.path)
    expect(paths).toEqual(['wi2.txt'])
    expect(paths).not.toContain('wi1.txt')
  })

  it('scopes the diff to a specific work-item branch via head (commit-to-commit)', async () => {
    // Two pushed work-item branches off the same base. Asking for one must show
    // only that branch's file, not the other's — and must ignore uncommitted
    // edits in the working tree (they belong to whatever branch is checked out).
    const repo = path.join(tmp, 'heads')
    const git = await initRepo(repo)
    await fs.writeFile(path.join(repo, 'base.txt'), 'base\n')
    await git.add('.')
    await git.commit('base')

    await git.checkoutLocalBranch('coro/wi-a')
    await fs.writeFile(path.join(repo, 'a.txt'), 'a\n')
    await git.add('.')
    await git.commit('a')

    await git.checkout(['main'])
    await git.checkoutLocalBranch('coro/wi-b')
    await fs.writeFile(path.join(repo, 'b.txt'), 'b\n')
    await git.add('.')
    await git.commit('b')

    // Uncommitted edit to a *tracked* file on the checked-out branch (wi-b).
    await fs.writeFile(path.join(repo, 'base.txt'), 'base changed\n')

    // Diff of wi-a (not checked out) -> only a.txt; the wi-b working-tree edit
    // to base.txt must NOT leak in, since we diff wi-a commit-to-commit.
    const a = await computeJobDiff({ repoDir: repo, base: 'main', head: 'coro/wi-a' })
    expect(a.files.map(f => f.path)).toEqual(['a.txt'])
    expect(a.head).toBe('coro/wi-a')

    // Diff of wi-b (checked out) -> committed b.txt AND the uncommitted base.txt edit.
    const b = await computeJobDiff({ repoDir: repo, base: 'main', head: 'coro/wi-b' })
    expect(b.files.map(f => f.path).sort()).toEqual(['b.txt', 'base.txt'].sort())
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

describe('resolveDiffBase', () => {
  it('honours an explicit override first', () => {
    const job = { params: { targetBranch: 'develop' }, artifacts: [] } as unknown as Job
    expect(resolveDiffBase(job, 'release/1.0')).toBe('release/1.0')
  })

  it('uses the latest pr-preview base when present', () => {
    const job = {
      params: { targetBranch: 'main' },
      artifacts: [
        { id: 'a', kind: 'pr-preview', data: { base: 'main' } },
        { id: 'b', kind: 'pr-preview', data: { base: 'coro/wi1' } }, // stacked PR targets prior WI branch
      ],
    } as unknown as Job
    expect(resolveDiffBase(job)).toBe('coro/wi1')
  })

  it('falls back to job params when no preview carries a base', () => {
    const job = {
      params: { targetBranch: 'develop' },
      artifacts: [{ id: 'a', kind: 'plan-md', data: {} }],
    } as unknown as Job
    expect(resolveDiffBase(job)).toBe('develop')
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
