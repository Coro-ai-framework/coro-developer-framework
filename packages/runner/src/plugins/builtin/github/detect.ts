// ── GitHub local credential detection ────────────────────────────────────────
//
// Surfaces every GitHub credential already on this machine so onboarding is a
// pick, not a paste. Two sources, both best-effort and non-interactive:
//
//   1. `gh`, once per signed-in account. Users commonly have a personal and a
//      work login; returning only the active one silently picks for them and
//      leaves no way to choose the other.
//   2. The git credential helper (macOS keychain, GCM, …), which is the only
//      source on machines without `gh`.
//
// Every token is validated against the API before being offered, and
// candidates are de-duplicated by resolved account so the same login coming
// from two sources appears once.

import { execFile } from 'node:child_process'
import type { CredentialCandidate } from '../../types'
import { listGhAccounts, tryGhAuthToken, validateGithubToken } from './gh-session'

const GH_TIMEOUT_MS = 3_000

function redactToken(token: string): string {
  if (token.length <= 8) return '…(redacted)'
  return `${token.slice(0, 4)}…${token.slice(-4)} (redacted)`
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
          // Never let a credential helper block on an interactive prompt —
          // this runs inside an HTTP request with no terminal attached.
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

interface DiscoveredToken {
  token: string
  sourceLabel: string
  /** Login `gh` reports, before API validation confirms it. */
  claimedLogin?: string
}

async function discoverTokens(): Promise<DiscoveredToken[]> {
  const found: DiscoveredToken[] = []

  const accounts = await listGhAccounts()
  for (const account of accounts) {
    // `--user` needs a reasonably recent gh; fall back to the plain read for
    // the active account so older installs still yield one candidate.
    const token =
      (await tryGhAuthToken(account.login))
      ?? (account.active ? await tryGhAuthToken() : null)
    if (!token) continue
    found.push({
      token,
      sourceLabel: account.active
        ? 'GitHub CLI session (active)'
        : 'GitHub CLI session',
      claimedLogin: account.login,
    })
  }

  // No accounts parsed (older gh, or output we don't recognise) — still try
  // the plain read before giving up on gh entirely.
  if (found.length === 0) {
    const token = await tryGhAuthToken()
    if (token) found.push({ token, sourceLabel: 'GitHub CLI session' })
  }

  const gitToken = await tryGitCredentialFill()
  if (gitToken) found.push({ token: gitToken, sourceLabel: 'Git credential helper' })

  return found
}

export async function detectGitHubCredentials(
  fetchFn: typeof fetch,
): Promise<ReadonlyArray<CredentialCandidate>> {
  const discovered = await discoverTokens()
  if (discovered.length === 0) return []

  const candidates: CredentialCandidate[] = []
  const seenTokens = new Set<string>()
  const seenLogins = new Set<string>()

  for (const entry of discovered) {
    if (seenTokens.has(entry.token)) continue
    seenTokens.add(entry.token)

    const account = await validateGithubToken(fetchFn, entry.token)
    if (!account) continue
    // The same account reached through two sources is one choice, not two.
    if (seenLogins.has(account.login)) continue
    seenLogins.add(account.login)

    candidates.push({
      id: `github-${account.login}`,
      sourceLabel: entry.sourceLabel,
      accountHint: account.login,
      config: { owner: account.login, token: entry.token },
      preview: [
        { label: 'Account', value: account.login },
        { label: 'Source', value: entry.sourceLabel },
        { label: 'Token', value: redactToken(entry.token) },
      ],
    })
  }

  return candidates
}
