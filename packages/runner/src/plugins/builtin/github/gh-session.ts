// ── GitHub CLI session helpers ───────────────────────────────────────────────
//
// Shared by credential detection and browser sign-in (gh auth login --web).

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const GH_TIMEOUT_MS = 3_000
const GH_LOGIN_TIMEOUT_MS = 5 * 60_000

export async function ghCommandExists(): Promise<boolean> {
  try {
    await execFileAsync('gh', ['--version'], { timeout: GH_TIMEOUT_MS, encoding: 'utf-8' })
    return true
  } catch {
    return false
  }
}

export async function tryGhAuthToken(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['auth', 'token', '--hostname', 'github.com'],
      { timeout: GH_TIMEOUT_MS, encoding: 'utf-8' },
    )
    const token = stdout.trim()
    return token.length > 0 ? token : null
  } catch {
    return null
  }
}

export async function validateGithubToken(
  fetchFn: typeof fetch,
  token: string,
): Promise<{ login: string } | null> {
  try {
    const res = await fetchFn('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'coro-runner',
      },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { login?: string }
    if (typeof body.login !== 'string' || !body.login) return null
    return { login: body.login }
  } catch {
    return null
  }
}

/** Start `gh auth login --web` and wait for the user to finish in the browser. */
export function runGhWebLogin(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'gh',
      [
        'auth',
        'login',
        '--hostname',
        'github.com',
        '--git-protocol',
        'https',
        '--web',
        '--scopes',
        'repo,read:user',
      ],
      {
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
        stdio: 'ignore',
      },
    )
    child.on('error', err => reject(err))
    child.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`GitHub CLI sign-in did not complete (exit ${code ?? 'unknown'}).`))
    })
  })
}

export async function waitForGhWebLogin(timeoutMs = GH_LOGIN_TIMEOUT_MS): Promise<void> {
  await Promise.race([
    runGhWebLogin(),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('GitHub sign-in timed out. Try again.')), timeoutMs)
    }),
  ])
}
