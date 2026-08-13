// ── GitLab local credential detection ────────────────────────────────────────

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CredentialCandidate } from '@coro-ai/plugin-sdk'

const execFileAsync = promisify(execFile)

const GLAB_TIMEOUT_MS = 3_000

function redactToken(token: string): string {
  if (token.length <= 8) return '…(redacted)'
  return `${token.slice(0, 4)}…${token.slice(-4)} (redacted)`
}

async function tryGlabAuthToken(): Promise<string | null> {
  for (const args of [['auth', 'token'], ['auth', 'status', '--show-token']] as const) {
    try {
      const { stdout } = await execFileAsync('glab', [...args], {
        timeout: GLAB_TIMEOUT_MS,
        encoding: 'utf-8',
      })
      const token = stdout.trim()
      if (token.length > 0 && !token.includes(' ')) return token
      const match = stdout.match(/Token:\s*(.+)$/m)
      if (match?.[1]?.trim()) return match[1].trim()
    } catch {
      /* try next */
    }
  }
  return null
}

async function tryGitCredentialFill(host: string): Promise<string | null> {
  return new Promise(resolve => {
    const child = execFile(
      'git',
      ['credential', 'fill'],
      {
        timeout: GLAB_TIMEOUT_MS,
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
    child.stdin?.write(`protocol=https\nhost=${host}\n\n`)
    child.stdin?.end()
  })
}

async function validateGitLabToken(
  fetchFn: typeof fetch,
  token: string,
  apiBase: string,
): Promise<{ username: string; namespace: string } | null> {
  try {
    const res = await fetchFn(`${apiBase}/user`, {
      headers: { 'PRIVATE-TOKEN': token, 'User-Agent': 'coro-runner' },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { username?: string; name?: string }
    const username = body.username ?? body.name
    if (typeof username !== 'string' || !username) return null
    return { username, namespace: username }
  } catch {
    return null
  }
}

export async function detectGitLabCredentials(
  fetchFn: typeof fetch,
  apiBase = 'https://gitlab.com/api/v4',
): Promise<ReadonlyArray<CredentialCandidate>> {
  const glabToken = await tryGlabAuthToken()
  const gitToken = glabToken ? null : await tryGitCredentialFill('gitlab.com')
  const token = glabToken ?? gitToken
  if (!token) return []

  const account = await validateGitLabToken(fetchFn, token, apiBase)
  if (!account) return []

  const sourceLabel = glabToken ? 'GitLab CLI session' : 'Git credential helper'
  return [
    {
      id: 'gitlab-detected-0',
      sourceLabel,
      accountHint: account.username,
      config: { namespace: account.namespace, token },
      preview: [
        { label: 'Account', value: account.username },
        { label: 'Token', value: redactToken(token) },
      ],
    },
  ]
}
