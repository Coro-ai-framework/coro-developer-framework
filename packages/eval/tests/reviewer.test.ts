import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeAction, readRecords, SimulatedReviewer, storeDir, storeFileName, type LocalPrRecord } from '../src/reviewer'
import { commitOnBranch, git, makeRepo, tmpDir } from './helpers/tmp'

async function setup(options: { approveAfterMs?: number; now?: () => number } = {}) {
  const { dir: sandbox, baseSha } = await makeRepo({ 'a.txt': 'base\n' })
  const home = tmpDir()
  const file = path.join(storeDir(home), storeFileName(sandbox))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const reviewer = new SimulatedReviewer({
    home,
    sandbox,
    approveAfterMs: options.approveAfterMs ?? 0,
    ...(options.now ? { now: options.now } : {}),
  })
  const put = (records: Array<Partial<LocalPrRecord> & { id: string; sourceBranch: string }>): void => {
    const full = records.map(r => ({ title: r.id, targetBranch: 'main', state: 'open', approvalCount: 0, comments: [], ...r }))
    fs.writeFileSync(file, JSON.stringify(full, null, 2))
  }
  return { sandbox, baseSha, home, file, reviewer, put }
}

const parked = { status: 'awaiting-pr-merge' }

describe('storeFileName', () => {
  it('names the record file after the repository path, as the local plugin does', () => {
    expect(storeFileName('/tmp/x/sandbox')).toBe('_tmp_x_sandbox.json')
    expect(storeFileName('/a b/c')).toBe('_a_b_c.json')
    expect(storeFileName('plain.repo-1')).toBe('plain.repo-1.json')
  })
})

describe('SimulatedReviewer: approving', () => {
  it('approves an open pull request while the job is parked on it', async () => {
    const { reviewer, put, file } = await setup()
    put([{ id: '1', sourceBranch: 'feat/a' }])
    const actions = await reviewer.tick(parked)
    expect(actions).toEqual([{ kind: 'approved', prId: '1' }])
    expect(readRecords(file)[0]!.approvalCount).toBe(1)
  })

  it('approves nothing while the job is doing something else', async () => {
    const { reviewer, put, file } = await setup()
    put([{ id: '1', sourceBranch: 'feat/a' }])
    expect(await reviewer.tick({ status: 'coding' })).toEqual([])
    expect(readRecords(file)[0]!.approvalCount).toBe(0)
  })

  it('leaves merged, declined and already-approved pull requests alone', async () => {
    const { reviewer, put, file } = await setup()
    put([
      { id: '1', sourceBranch: 'a', state: 'declined' },
      { id: '2', sourceBranch: 'b', state: 'open', approvalCount: 1 },
      { id: '3', sourceBranch: 'c', state: 'superseded' },
      { id: '4', sourceBranch: 'd', state: 'open' },
    ])
    const actions = await reviewer.tick(parked)
    expect(actions).toEqual([{ kind: 'approved', prId: '4' }])
    expect(readRecords(file).map(r => r.approvalCount)).toEqual([0, 1, 0, 1])
  })

  it('does not approve again on the next look', async () => {
    const { reviewer, put } = await setup()
    put([{ id: '1', sourceBranch: 'a' }])
    await reviewer.tick(parked)
    expect(await reviewer.tick(parked)).toEqual([])
  })

  it('waits the configured delay after the job parks before approving', async () => {
    let clock = 1_000
    const { reviewer, put } = await setup({ approveAfterMs: 5_000, now: () => clock })
    put([{ id: '1', sourceBranch: 'a' }])
    expect(await reviewer.tick(parked)).toEqual([])
    clock += 4_999
    expect(await reviewer.tick(parked)).toEqual([])
    clock += 1
    expect(await reviewer.tick(parked)).toHaveLength(1)
  })

  it('starts the delay over when the job leaves the park and returns', async () => {
    let clock = 0
    const { reviewer, put } = await setup({ approveAfterMs: 5_000, now: () => clock })
    put([{ id: '1', sourceBranch: 'a' }])
    await reviewer.tick(parked)
    clock += 4_000
    await reviewer.tick({ status: 'coding' })
    clock += 4_000
    expect(await reviewer.tick(parked)).toEqual([]) // only just parked again
    clock += 5_000
    expect(await reviewer.tick(parked)).toHaveLength(1)
  })

  it('leaves no temporary file behind', async () => {
    const { reviewer, put, home } = await setup()
    put([{ id: '1', sourceBranch: 'a' }])
    await reviewer.tick(parked)
    expect(fs.readdirSync(storeDir(home)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('survives a record file that is half-written or missing', async () => {
    const { reviewer, file } = await setup()
    expect(await reviewer.tick(parked)).toEqual([])
    fs.writeFileSync(file, '[{"id":"1","sourceBra')
    expect(await reviewer.tick(parked)).toEqual([])
  })

  it('finds the record file even if the plugin keyed it differently', async () => {
    const { reviewer, home } = await setup()
    const odd = path.join(storeDir(home), 'something-else.json')
    fs.writeFileSync(odd, JSON.stringify([{ id: '7', sourceBranch: 'x', state: 'open', approvalCount: 0 }]))
    expect(await reviewer.tick(parked)).toEqual([{ kind: 'approved', prId: '7' }])
    expect(readRecords(odd)[0]!.approvalCount).toBe(1)
  })
})

describe('SimulatedReviewer: merging', () => {
  it('merges the branch of a merged pull request into main, once', async () => {
    const { reviewer, put, sandbox, baseSha } = await setup()
    await commitOnBranch(sandbox, 'feat/a', 'a.txt', 'changed by a\n')
    put([{ id: '1', sourceBranch: 'feat/a', state: 'merged', approvalCount: 1 }])

    expect(await reviewer.tick({ status: 'coding' })).toEqual([{ kind: 'merged', prId: '1', branch: 'feat/a' }])
    expect((await git(sandbox, 'rev-parse', 'main')).trim()).not.toBe(baseSha)
    expect(fs.readFileSync(path.join(sandbox, 'a.txt'), 'utf-8')).toBe('changed by a\n')
    expect(await reviewer.tick({ status: 'coding' })).toEqual([])
  })

  it('lets a second work item build on the first', async () => {
    const { reviewer, put, sandbox } = await setup()
    await commitOnBranch(sandbox, 'feat/a', 'a.txt', 'one\n')
    put([{ id: '1', sourceBranch: 'feat/a', state: 'merged' }])
    await reviewer.tick({ status: 'coding' })

    // The job cuts its next branch from a main that now has the first change.
    await commitOnBranch(sandbox, 'feat/b', 'b.txt', 'two\n')
    put([
      { id: '1', sourceBranch: 'feat/a', state: 'merged' },
      { id: '2', sourceBranch: 'feat/b', state: 'merged' },
    ])
    expect(await reviewer.tick({ status: 'coding' })).toEqual([{ kind: 'merged', prId: '2', branch: 'feat/b' }])
    expect(fs.readFileSync(path.join(sandbox, 'a.txt'), 'utf-8')).toBe('one\n')
    expect(fs.readFileSync(path.join(sandbox, 'b.txt'), 'utf-8')).toBe('two\n')
  })

  it('reports a branch that does not exist, and does not retry it', async () => {
    const { reviewer, put } = await setup()
    put([{ id: '1', sourceBranch: 'ghost', state: 'merged' }])
    const [action] = await reviewer.tick({ status: 'coding' })
    expect(action).toMatchObject({ kind: 'merge-failed', prId: '1', branch: 'ghost' })
    expect(await reviewer.tick({ status: 'coding' })).toEqual([])
  })

  it('aborts a conflicting merge and leaves the sandbox clean', async () => {
    const { reviewer, put, sandbox } = await setup()
    await commitOnBranch(sandbox, 'feat/a', 'a.txt', 'from a\n')
    await commitOnBranch(sandbox, 'feat/b', 'a.txt', 'from b\n')
    put([
      { id: '1', sourceBranch: 'feat/a', state: 'merged' },
      { id: '2', sourceBranch: 'feat/b', state: 'merged' },
    ])
    const actions = await reviewer.tick({ status: 'coding' })
    expect(actions.map(a => a.kind)).toEqual(['merged', 'merge-failed'])

    expect((await git(sandbox, 'status', '--porcelain')).trim()).toBe('')
    expect(fs.existsSync(path.join(sandbox, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(fs.readFileSync(path.join(sandbox, 'a.txt'), 'utf-8')).toBe('from a\n')
    expect(await reviewer.tick({ status: 'coding' })).toEqual([])
  })

  it('merges before it approves, so one look can do both', async () => {
    const { reviewer, put, sandbox } = await setup()
    await commitOnBranch(sandbox, 'feat/a', 'a.txt', 'one\n')
    put([
      { id: '1', sourceBranch: 'feat/a', state: 'merged' },
      { id: '2', sourceBranch: 'feat/b', state: 'open' },
    ])
    const actions = await reviewer.tick(parked)
    expect(actions.map(a => a.kind)).toEqual(['merged', 'approved'])
  })
})

describe('describeAction', () => {
  it('says what the reviewer did', () => {
    expect(describeAction({ kind: 'approved', prId: '3' })).toBe('reviewer: approved PR 3')
    expect(describeAction({ kind: 'merged', prId: '3', branch: 'f' })).toContain('merged f (PR 3)')
    expect(describeAction({ kind: 'merge-failed', prId: '3', branch: 'f', detail: 'conflict' })).toContain('conflict')
  })
})
