import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { patchIdsOf } from '../../src/reviews/prepare'
import { buildPacket } from '../../src/reviews/packet'
import { readLocalDiff, splitPatches } from '../../src/reviews/local-diff'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  })
}

describe('readLocalDiff', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'coro-local-diff-'))
    git(dir, 'init', '-q', '-b', 'main')
    mkdirSync(path.join(dir, 'src'))
    writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1\nexport const b = 2\n')
    writeFileSync(path.join(dir, 'README.md'), '# hi\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'base')
    git(dir, 'checkout', '-q', '-b', 'feature')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads committed changes against the merge base', async () => {
    writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1\nexport const b = 3\nexport const c = 4\n')
    git(dir, 'commit', '-q', '-am', 'change')

    const diff = await readLocalDiff(dir, 'main')

    expect(diff.files).toHaveLength(1)
    expect(diff.files[0]).toMatchObject({ path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 })
    expect(diff.files[0]!.patch).toMatch(/^@@/)
    expect(diff.files[0]!.patch).toContain('+export const c = 4')
  })

  it('includes uncommitted edits and untracked files without touching the index', async () => {
    writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 9\nexport const b = 2\n')
    writeFileSync(path.join(dir, 'src/new.ts'), 'export const n = 1\nexport const m = 2\n')
    const statusBefore = git(dir, 'status', '--porcelain')

    const diff = await readLocalDiff(dir, 'main')

    expect(diff.files.map(file => file.path).sort()).toEqual(['src/a.ts', 'src/new.ts'])
    const added = diff.files.find(file => file.path === 'src/new.ts')!
    expect(added).toMatchObject({ status: 'added', additions: 2, deletions: 0 })
    expect(added.patch).toBe('@@ -0,0 +1,2 @@\n+export const n = 1\n+export const m = 2')
    expect(git(dir, 'status', '--porcelain')).toBe(statusBefore)
  })

  it('reports a rename under its new path', async () => {
    git(dir, 'mv', 'src/a.ts', 'src/renamed.ts')
    git(dir, 'commit', '-q', '-m', 'rename')

    const diff = await readLocalDiff(dir, 'main')

    expect(diff.files.map(file => file.path)).toEqual(['src/renamed.ts'])
    expect(diff.files[0]!.status).toBe('renamed')
  })

  it('returns an empty diff when nothing changed, and a diff the packet can use', async () => {
    expect((await readLocalDiff(dir, 'main')).files).toEqual([])

    writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 2\n')
    const diff = await readLocalDiff(dir, 'main')
    const packet = buildPacket({
      files: diff.files.map(file => ({ path: file.path, additions: file.additions, deletions: file.deletions, ...(file.patch ? { hunks: file.patch } : {}) })),
      lenses: [{ name: 'correctness', when: ['code'] }],
      maxDiffLines: 4000,
      maxLensInputTokens: 100_000,
      contextTokens: 200_000,
    })
    expect(packet.routes).toEqual([{ name: 'correctness', when: ['code'], paths: ['src/a.ts'] }])
    expect(Object.keys(patchIdsOf(diff))).toEqual(['src/a.ts'])
  })

  it('rejects a base that does not exist or looks like a flag', async () => {
    await expect(readLocalDiff(dir, 'nope')).rejects.toThrow(/does not exist/)
    await expect(readLocalDiff(dir, '--output=x')).rejects.toThrow(/not a usable base/)
  })
})

describe('splitPatches', () => {
  it('keys each patch by the new path and starts it at the first hunk', () => {
    const patches = splitPatches([
      'diff --git a/x.ts b/x.ts',
      'index 1..2 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/y.ts b/y.ts',
      'Binary files a/y.ts and b/y.ts differ',
      '',
    ].join('\n'))
    expect(patches.get('x.ts')).toBe('@@ -1 +1 @@\n-a\n+b')
    expect(patches.get('y.ts')).toBe('')
  })
})
