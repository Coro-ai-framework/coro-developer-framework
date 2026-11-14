import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'
import { gitResult } from '../../src/git'

const made: string[] = []

// After the file, not after each test: a directory made in `beforeAll` must outlive the first test.
afterAll(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** A fresh directory that is removed after the test. Resolved so macOS /var -> /private/var cannot confuse comparisons. */
export function tmpDir(prefix = 'coro-eval-test-'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  made.push(dir)
  return dir
}

export function write(root: string, file: string, text: string): string {
  const target = path.join(root, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text)
  return target
}

const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false']

/** `git` for tests: throws on failure, returns stdout. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await gitResult([...IDENTITY, ...args], cwd)
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

/** A git repo on `main` with one commit containing `files`. Returns its path and the base commit. */
export async function makeRepo(files: Record<string, string> = { 'README.md': '# fixture\n' }): Promise<{ dir: string; baseSha: string }> {
  const dir = path.join(tmpDir(), 'repo')
  fs.mkdirSync(dir, { recursive: true })
  for (const [file, text] of Object.entries(files)) write(dir, file, text)
  await git(dir, 'init', '-q', '-b', 'main')
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', 'base')
  const baseSha = (await git(dir, 'rev-parse', 'HEAD')).trim()
  return { dir, baseSha }
}

/** Create `branch` from `main` with one commit that writes `file`, then return to main. */
export async function commitOnBranch(dir: string, branch: string, file: string, text: string, from = 'main'): Promise<string> {
  await git(dir, 'checkout', '-q', '-B', branch, from)
  write(dir, file, text)
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', `work on ${branch}`)
  const sha = (await git(dir, 'rev-parse', 'HEAD')).trim()
  await git(dir, 'checkout', '-q', 'main')
  return sha
}
