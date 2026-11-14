import fs from 'node:fs'
import path from 'node:path'
import type { Job } from '@coro-ai/cloud-protocol'
import { describe, expect, it } from 'vitest'
import { announcedBranches, collectDelivery, DELIVERED_BRANCH, deliveredDiff, deliveredNumstat, saveJob } from '../src/collect'
import { commitOnBranch, git, makeRepo, tmpDir } from './helpers/tmp'

const jobWith = (branches: string[]): Job =>
  ({
    artifacts: branches.map(sourceBranch => ({ kind: 'pr-preview', data: { sourceBranch } })),
  }) as unknown as Job

describe('announcedBranches', () => {
  it('lists the branches announced in pr-preview artefacts, oldest first, without duplicates', () => {
    expect(announcedBranches(jobWith(['a', 'b', 'a']))).toEqual(['a', 'b'])
  })

  it('ignores other artefacts and malformed data', () => {
    const job = {
      artifacts: [
        { kind: 'plan', data: { sourceBranch: 'no' } },
        { kind: 'pr-preview', data: { sourceBranch: 5 } },
        { kind: 'pr-preview', data: {} },
        { kind: 'pr-preview' },
        { kind: 'pr-preview', data: { sourceBranch: 'yes' } },
      ],
    } as unknown as Job
    expect(announcedBranches(job)).toEqual(['yes'])
  })

  it('copes with no job', () => {
    expect(announcedBranches(undefined)).toEqual([])
  })
})

describe('collectDelivery', () => {
  it('reports nothing delivered when nothing was pushed', async () => {
    const { dir, baseSha } = await makeRepo()
    const delivery = await collectDelivery({ sandbox: dir, baseSha })
    expect(delivery).toEqual({ delivered: false, baseSha, branches: [], skippedBranches: [] })
    expect(await deliveredDiff(dir, delivery)).toBe('')
    expect(await deliveredNumstat(dir, delivery)).toBe('')
  })

  it('takes main as the deliverable when the reviewer merged into it', async () => {
    const { dir, baseSha } = await makeRepo({ 'a.txt': 'base\n' })
    await commitOnBranch(dir, 'feat/a', 'a.txt', 'changed\n')
    await git(dir, 'merge', '--no-ff', '--no-edit', 'feat/a')

    const delivery = await collectDelivery({ sandbox: dir, baseSha, job: jobWith(['feat/a']) })
    expect(delivery).toMatchObject({ delivered: true, via: 'merged', branches: ['feat/a'], skippedBranches: [] })
    expect((await git(dir, 'rev-parse', DELIVERED_BRANCH)).trim()).toBe(delivery.headSha)
    expect(await deliveredDiff(dir, delivery)).toContain('+changed')
    expect(await deliveredNumstat(dir, delivery)).toBe('1\t1\ta.txt\n')
  })

  it('names a pushed branch that never reached main as skipped', async () => {
    const { dir, baseSha } = await makeRepo({ 'a.txt': 'base\n' })
    await commitOnBranch(dir, 'feat/a', 'a.txt', 'one\n')
    await git(dir, 'merge', '--no-ff', '--no-edit', 'feat/a')
    await commitOnBranch(dir, 'feat/b', 'b.txt', 'two\n')

    const delivery = await collectDelivery({ sandbox: dir, baseSha })
    expect(delivery).toMatchObject({ via: 'merged', branches: ['feat/a'], skippedBranches: ['feat/b'] })
  })

  it('combines pushed branches when nothing was merged, and keeps main untouched', async () => {
    const { dir, baseSha } = await makeRepo({ 'a.txt': 'base\n' })
    await commitOnBranch(dir, 'feat/a', 'a.txt', 'one\n')
    await commitOnBranch(dir, 'feat/b', 'b.txt', 'two\n')

    const delivery = await collectDelivery({ sandbox: dir, baseSha, job: jobWith(['feat/a', 'feat/b']) })
    expect(delivery).toMatchObject({ delivered: true, via: 'branches', branches: ['feat/a', 'feat/b'], skippedBranches: [] })
    expect((await git(dir, 'rev-parse', 'main')).trim()).toBe(baseSha)
    expect((await git(dir, 'branch', '--show-current')).trim()).toBe('main')
    expect(await git(dir, 'show', `${DELIVERED_BRANCH}:b.txt`)).toBe('two\n')
    expect(await git(dir, 'show', `${DELIVERED_BRANCH}:a.txt`)).toBe('one\n')
  })

  it('skips a branch that conflicts with the others and says so', async () => {
    const { dir, baseSha } = await makeRepo({ 'a.txt': 'base\n' })
    await commitOnBranch(dir, 'feat/a', 'a.txt', 'from a\n')
    await commitOnBranch(dir, 'feat/b', 'a.txt', 'from b\n')

    const delivery = await collectDelivery({ sandbox: dir, baseSha, job: jobWith(['feat/a', 'feat/b']) })
    expect(delivery).toMatchObject({ delivered: true, via: 'branches', branches: ['feat/a'], skippedBranches: ['feat/b'] })
    expect((await git(dir, 'status', '--porcelain')).trim()).toBe('')
  })

  it('does not count a branch with no commits of its own', async () => {
    const { dir, baseSha } = await makeRepo()
    await git(dir, 'branch', 'empty')
    const delivery = await collectDelivery({ sandbox: dir, baseSha })
    expect(delivery.delivered).toBe(false)
  })

  it('does not mistake its own eval/ branches for the job\'s work', async () => {
    const { dir, baseSha } = await makeRepo()
    await commitOnBranch(dir, 'eval/scratch', 'x.txt', 'x\n')
    expect((await collectDelivery({ sandbox: dir, baseSha })).delivered).toBe(false)
  })

  it('applies announced branches first, in announcement order', async () => {
    const { dir, baseSha } = await makeRepo()
    await commitOnBranch(dir, 'zzz-first', 'z.txt', 'z\n')
    await commitOnBranch(dir, 'aaa-second', 'a.txt', 'a\n')
    const delivery = await collectDelivery({ sandbox: dir, baseSha, job: jobWith(['zzz-first', 'aaa-second']) })
    expect(delivery.branches).toEqual(['zzz-first', 'aaa-second'])
  })

  it('can be run twice and delivers the same content (the merge commit itself carries a timestamp)', async () => {
    const { dir, baseSha } = await makeRepo()
    await commitOnBranch(dir, 'feat/a', 'a.txt', 'one\n')
    await commitOnBranch(dir, 'feat/b', 'b.txt', 'two\n')
    const first = await collectDelivery({ sandbox: dir, baseSha })
    const treeOf = async (sha: string | undefined) => (await git(dir, 'rev-parse', `${sha}^{tree}`)).trim()
    const firstTree = await treeOf(first.headSha)
    const second = await collectDelivery({ sandbox: dir, baseSha })
    expect(second).toMatchObject({ delivered: true, via: 'branches', branches: first.branches })
    expect(await treeOf(second.headSha)).toBe(firstTree)
  })
})

describe('saveJob', () => {
  it('writes the raw record as job.json', async () => {
    const dir = tmpDir()
    await saveJob({ id: 'j1', status: 'complete' } as unknown as Job, dir)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf-8'))).toEqual({ id: 'j1', status: 'complete' })
  })
})
