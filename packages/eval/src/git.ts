import { execFile } from 'node:child_process'

/**
 * Git as the harness uses it: deterministic and independent of whoever runs
 * it. Global and system config are ignored and the identity is fixed, so a
 * merge or commit made here behaves the same on every machine.
 */
export const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'Coro Eval',
  GIT_AUTHOR_EMAIL: 'coro-eval@example.invalid',
  GIT_COMMITTER_NAME: 'Coro Eval',
  GIT_COMMITTER_EMAIL: 'coro-eval@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
}

const BASE_ARGS = ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main']

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

/** Run git and return its result without throwing on a non-zero exit. */
export function gitResult(args: readonly string[], cwd: string, timeoutMs = 120_000): Promise<GitResult> {
  return new Promise(resolve => {
    execFile(
      'git',
      [...BASE_ARGS, ...args],
      { cwd, env: { ...process.env, ...GIT_ENV }, maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}

/** Run git and return stdout; throws with git's stderr on a non-zero exit. */
export async function git(args: readonly string[], cwd: string, timeoutMs?: number): Promise<string> {
  const result = await gitResult(args, cwd, timeoutMs)
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.code}) in ${cwd}: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result.stdout
}

export async function revParse(cwd: string, ref: string): Promise<string | undefined> {
  const result = await gitResult(['rev-parse', '--verify', '--quiet', ref], cwd)
  return result.code === 0 ? result.stdout.trim() : undefined
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await revParse(cwd, `refs/heads/${branch}`)) !== undefined
}

export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await gitResult(['merge-base', '--is-ancestor', ancestor, descendant], cwd)
  return result.code === 0
}

/** Current commit and whether the work tree has uncommitted changes. */
export async function describeCheckout(cwd: string): Promise<{ sha: string | null; dirty: boolean }> {
  const sha = await revParse(cwd, 'HEAD')
  if (!sha) return { sha: null, dirty: false }
  const status = await gitResult(['status', '--porcelain'], cwd)
  return { sha, dirty: status.code === 0 && status.stdout.trim().length > 0 }
}
