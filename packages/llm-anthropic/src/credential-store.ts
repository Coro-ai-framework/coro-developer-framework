// ── Claude CLI credential store ─────────────────────────────────────────────
//
// Read (and renew) the OAuth session that the Claude CLI persists on this
// host. Used by the `claudeLogin` auth method, which deliberately stores no
// tokens in Coro's own config — the CLI's store is the single source of
// truth, shared with any interactive Claude Code on the same machine.
//
// Anthropic issues claude.ai access tokens with an **8-hour** lifetime
// alongside a long-lived refresh token. The lifetime is not negotiable: the
// CLI's own long-lived-token path asks for a year
// (`expires_in: 31536000`) and the server still returns 8 hours for
// full-scope tokens — only inference-only tokens (`claude setup-token`)
// get the long expiry, and those lack `user:mcp_servers`.
//
// So an 8-hour expiry is normal and must be renewed rather than reported as
// a dead end. {@link refreshClaudeLocalSession} does that by handing the
// stored refresh token back to the CLI's own non-interactive login path,
// which exchanges it and rewrites the store through the CLI's own writer.
// Going through the CLI (rather than calling the token endpoint ourselves)
// keeps Coro out of the business of knowing the credential format, the
// keychain ACLs, or the cross-process locking.

import { execFile, execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import path from 'path'
import type { Logger } from 'pino'
import { ensureClaudeCodeCliExecutable, resolveClaudeCodeCliPath } from './cli-path'

export interface ClaudeLocalSession {
  accessToken: string | null
  refreshToken?: string | null
  expiresAt?: number
  scopes?: ReadonlyArray<string>
  accountEmail?: string
  organizationName?: string
}

/**
 * Treat a session as unusable slightly before its stated expiry so we don't
 * hand out a token that dies mid-request.
 *
 * Deliberately much tighter than the CLI's own 5-minute refresh window: the
 * CLI renews before every API call it makes, so in the normal case (jobs
 * running regularly) it keeps the store fresh on its own and Coro never
 * intervenes. We only step in for the case the CLI cannot cover — the runner
 * idling past the 8-hour expiry with no Claude Code process to trigger a
 * renewal. Refreshing rotates the refresh token, so a wider window here
 * would mean Coro racing the many `claude` subprocesses it spawns for
 * parallel job phases.
 */
const EXPIRY_BUFFER_MS = 60_000

/** Give the refresh exchange a bounded window before declaring it failed. */
const REFRESH_TIMEOUT_MS = 60_000

/**
 * Scopes to request if the stored session somehow records none. Matches the
 * CLI's default full-scope set for a claude.ai login.
 */
const DEFAULT_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
] as const

/** True when `expiresAt` has passed (or is about to). */
export function isSessionExpired(expiresAt: number | undefined): boolean {
  if (expiresAt === undefined) return false
  return Date.now() + EXPIRY_BUFFER_MS >= expiresAt
}

/**
 * Read the persisted Claude CLI OAuth session from the platform's
 * credential store.
 *
 *   - **macOS** — `security find-generic-password -s "Claude Code-credentials" -w`
 *     returns a JSON blob `{ claudeAiOauth: { accessToken, refreshToken,
 *     expiresAt, scopes, subscriptionType } }`.
 *   - **Linux** — the same JSON blob lives at `~/.claude/.credentials.json`.
 *   - **Windows** — Claude Code stores via DPAPI; we have no public path
 *     to read it without spawning the CLI itself, so we degrade to a
 *     "couldn't read" error and ask the user to use an API key.
 *
 * The accompanying account metadata (email / organization) lives in
 * `~/.claude.json` — we read it best-effort so the success message can
 * include the account name.
 */
export function readClaudeLocalSession(): ClaudeLocalSession {
  const raw = readRawCredentialBlob()
  const blob = parseCredentialBlob(raw)
  const account = readClaudeAccountInfo()
  return {
    accessToken: blob.accessToken,
    refreshToken: blob.refreshToken,
    expiresAt: blob.expiresAt,
    scopes: blob.scopes,
    accountEmail: account.email,
    organizationName: account.organizationName,
  }
}

/**
 * Read the stored session, renewing it first when the access token has
 * expired (or is about to).
 *
 * This is what callers should use instead of {@link readClaudeLocalSession}
 * whenever the token is about to be *used*. An expired access token is a
 * routine, self-healing condition — reporting it as a failure is what used
 * to force a manual "Reconnect" roughly every 8 hours.
 *
 * Never throws on refresh failure: the returned session is simply still
 * expired, and the caller renders its own message.
 */
export async function loadClaudeLocalSession(logger?: Logger): Promise<ClaudeLocalSession> {
  // A missing store (never logged in, or an unsupported platform) has
  // nothing to refresh, so the read error propagates to the caller.
  const session = readClaudeLocalSession()

  if (!session.accessToken || !isSessionExpired(session.expiresAt)) return session
  if (!(await refreshClaudeLocalSession(logger))) return session

  try {
    return readClaudeLocalSession()
  } catch {
    return session
  }
}

/** Serialises concurrent refresh attempts inside this process. */
let inFlightRefresh: Promise<boolean> | null = null

/**
 * When the last attempt failed. A revoked or expired refresh token fails
 * every time, and `healthcheck()` runs on every dashboard poll — without a
 * cooldown that would spawn a CLI process per poll for a session that can
 * only be fixed by a human clicking Reconnect.
 */
let lastRefreshFailureAt: number | null = null

/** How long to stop retrying after a failed exchange. */
const REFRESH_FAILURE_COOLDOWN_MS = 60_000

/**
 * Exchange the stored refresh token for a fresh access token and write it
 * back to the credential store.
 *
 * Delegates to `claude auth login`, which reads
 * `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` / `CLAUDE_CODE_OAUTH_SCOPES` and runs
 * the exchange non-interactively. The CLI validates the new token against
 * the API before persisting it, and only writes on success — so a network
 * failure here leaves the existing credentials untouched.
 *
 * Returns false (never throws) when there is nothing to refresh with or the
 * exchange fails; the caller decides how to report that.
 */
export async function refreshClaudeLocalSession(logger?: Logger): Promise<boolean> {
  if (inFlightRefresh) return inFlightRefresh
  if (
    lastRefreshFailureAt !== null &&
    Date.now() - lastRefreshFailureAt < REFRESH_FAILURE_COOLDOWN_MS
  ) {
    return false
  }
  inFlightRefresh = performRefresh(logger)
    .then(ok => {
      lastRefreshFailureAt = ok ? null : Date.now()
      return ok
    })
    .finally(() => {
      inFlightRefresh = null
    })
  return inFlightRefresh
}

/** Clear the failure cooldown so a fresh login is picked up immediately. */
export function resetRefreshCooldown(): void {
  lastRefreshFailureAt = null
}

async function performRefresh(logger?: Logger): Promise<boolean> {
  let session: ClaudeLocalSession
  try {
    session = readClaudeLocalSession()
  } catch (err) {
    logger?.debug({ err }, 'anthropic.refresh: no local credential store to refresh')
    return false
  }

  if (!session.refreshToken) {
    // Inference-only tokens (`claude setup-token`) carry no refresh token,
    // and neither does a store that was never populated by a real login.
    logger?.debug('anthropic.refresh: stored session has no refresh token')
    return false
  }

  let cliPath: string
  try {
    cliPath = resolveClaudeCodeCliPath()
  } catch (err) {
    logger?.warn({ err }, 'anthropic.refresh: could not locate the Claude CLI')
    return false
  }
  if (logger) ensureClaudeCodeCliExecutable(cliPath, logger)

  const scopes = session.scopes?.length ? [...session.scopes] : [...DEFAULT_SCOPES]
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  // The CLI short-circuits to env-supplied credentials when either of these
  // is set, which would bypass the stored session we are trying to renew.
  delete env['ANTHROPIC_API_KEY']
  delete env['CLAUDE_CODE_OAUTH_TOKEN']
  env['CLAUDE_CODE_OAUTH_REFRESH_TOKEN'] = session.refreshToken
  env['CLAUDE_CODE_OAUTH_SCOPES'] = scopes.join(' ')

  logger?.info({ scopes }, 'anthropic.refresh: renewing the Claude session from its refresh token')

  return new Promise<boolean>(resolve => {
    execFile(
      cliPath,
      ['auth', 'login'],
      { env, timeout: REFRESH_TIMEOUT_MS, encoding: 'utf-8' },
      (err, _stdout, stderr) => {
        if (err) {
          logger?.warn(
            { err, stderr: (stderr ?? '').slice(0, 500) },
            'anthropic.refresh: refresh-token exchange failed',
          )
          resolve(false)
          return
        }
        logger?.info('anthropic.refresh: Claude session renewed')
        resolve(true)
      },
    )
  })
}

function readRawCredentialBlob(): string {
  if (process.platform === 'darwin') {
    try {
      // `-w` prints the password value to stdout; service name matches
      // what the Claude CLI uses for its persisted OAuth blob.
      return execFileSync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim()
    } catch {
      throw new Error('No Claude Code keychain entry found.')
    }
  }
  if (process.platform === 'linux') {
    const filePath = path.join(homedir(), '.claude', '.credentials.json')
    try {
      return readFileSync(filePath, 'utf-8')
    } catch {
      throw new Error(`No Claude credentials file at ${filePath}.`)
    }
  }
  throw new Error(
    `Reading the local Claude session is not supported on ${process.platform}. Use an Anthropic API key for now.`,
  )
}

function parseCredentialBlob(text: string): {
  accessToken: string | null
  refreshToken: string | null
  expiresAt?: number
  scopes?: ReadonlyArray<string>
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error('Local Claude credential store is not valid JSON.')
  }
  const oauth =
    parsed && typeof parsed === 'object' && 'claudeAiOauth' in parsed
      ? ((parsed as { claudeAiOauth: unknown }).claudeAiOauth as Record<string, unknown>)
      : (parsed as Record<string, unknown>)
  return {
    accessToken: typeof oauth['accessToken'] === 'string' ? (oauth['accessToken'] as string) : null,
    refreshToken: typeof oauth['refreshToken'] === 'string' ? (oauth['refreshToken'] as string) : null,
    expiresAt: typeof oauth['expiresAt'] === 'number' ? (oauth['expiresAt'] as number) : undefined,
    scopes: Array.isArray(oauth['scopes']) ? (oauth['scopes'] as string[]) : undefined,
  }
}

function readClaudeAccountInfo(): { email?: string; organizationName?: string } {
  try {
    const filePath = path.join(homedir(), '.claude.json')
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const account = parsed['oauthAccount'] as Record<string, unknown> | undefined
    if (!account) return {}
    return {
      email: typeof account['emailAddress'] === 'string' ? (account['emailAddress'] as string) : undefined,
      organizationName:
        typeof account['organizationName'] === 'string' ? (account['organizationName'] as string) : undefined,
    }
  } catch {
    return {}
  }
}
