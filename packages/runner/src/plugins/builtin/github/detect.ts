// ── GitHub local credential detection ────────────────────────────────────────

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CredentialCandidate } from '../../types'

const execFileAsync = promisify(execFile)

const GH_TIMEOUT_MS = 3_000

function redactToken(token: string): string {
  if (token.length <= 8) return '…(redacted)'
  return `${token.slice(0, 4)}…${token.slice(-4)} (redacted)`
}

async function tryGhAuthToken(): Promise<string | null> {
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

async function tryGitCredentialFill(): Promise<string | null> {
  return new Promise(resolve => {
    const child = execFile(
      'git',
      ['credential', 'fill'],
      {
        timeout: GH_TIMEOUT_MS,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
        },
        encoding: 'utf-8',
      },
      (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        const match = stdout.match(/^password=(.+)$/m)
        resolve(match?.[1]?.trim() || null)
      },
    )
    child.stdin?.write('protocol=https\nhost=github.com\n\n')
    child.stdin?.end()
  })
}

async function validateGithubToken(
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

export async function detectGitHubCredentials(
  fetchFn: typeof fetch,
): Promise<ReadonlyArray<CredentialCandidate>> {
  const ghToken = await tryGhAuthToken()
  const gitToken = ghToken ? null : await tryGitCredentialFill()
  const token = ghToken ?? gitToken
  if (!token) return []

  const account = await validateGithubToken(fetchFn, token)
  if (!account) return []

  const sourceLabel = ghToken ? 'GitHub CLI session' : 'Git credential helper'
  return [
    {
      id: 'github-detected-0',
      sourceLabel,
      accountHint: account.login,
      config: { owner: account.login, token },
      preview: [
        { label: 'Account', value: account.login },
        { label: 'Token', value: redactToken(token) },
      ],
    },
  ]
}
