// ── Anthropic credential probe ──────────────────────────────────────────────
//
// Active "does this auth actually work?" check, invoked by the dashboard's
// "Test connection" button (Settings + FTUE) via `POST /test/llm` →
// `AnthropicExecutor.testConnection()`. Distinct from `healthcheck()`,
// which is a passive shape-only check.
//
// Why this lives in the plugin (not the runner): every LLM provider has
// its own auth shape, base URL, and beta headers. Putting the probe here
// means `server.ts` carries zero Anthropic-specific code — adding a new
// LLM plugin requires zero edits to the runner.
//
// The `claudeLogin` branch is the interesting one. It does NOT trust the
// Claude CLI's own `auth status` (which reports `loggedIn: true` even
// when the API rejects the token — observed bug). Instead it pulls the
// OAuth access token straight out of the platform's local credential
// store and round-trips it against `/v1/messages` with `max_tokens: 1`
// so a stale-but-cached token surfaces as a clear failure here rather
// than as a 401 on the user's first real job.

import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import path from 'path'
import type { PluginTestCheck, PluginTestResult } from '@coro-ai/plugin-sdk'
import type { ClaudeAuthConfig } from './types'

/** Beta header the Claude CLI sends on OAuth-backed requests. */
const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

/** Anthropic API base. */
const ANTHROPIC_API = 'https://api.anthropic.com'

/** Cheapest available current model — pings cost ~1 token. */
const PROBE_MODEL = 'claude-haiku-4-5'

/**
 * Run a live credential probe against Anthropic and return a structured
 * result the dashboard can render directly. Branches on `auth.method`:
 *
 *   - `apiKey`     → POST /v1/messages with `x-api-key`.
 *   - `oauth`      → POST /v1/messages with `Authorization: Bearer …`
 *                    (the user-pasted long-lived OAuth token).
 *   - `claudeLogin`→ Read the persisted Claude CLI session from the
 *                    platform credential store, then probe with the
 *                    same bearer-token call. This is what catches the
 *                    "Claude says I'm logged in but Anthropic 401s"
 *                    failure mode.
 *
 * Never throws — every failure path returns `{ ok: false, message, … }`.
 */
export async function testAnthropicCredentials(
  auth: ClaudeAuthConfig,
): Promise<PluginTestResult> {
  const method = auth.method ?? 'claudeLogin'

  if (method === 'apiKey') {
    const apiKey = (auth.apiKey ?? '').trim()
    if (!apiKey) {
      return { ok: false, message: 'An Anthropic API key is required.' }
    }
    return probeMessagesEndpoint({ headers: { 'x-api-key': apiKey } })
  }

  if (method === 'oauth') {
    const token = (auth.oauthToken ?? '').trim()
    if (!token) {
      return { ok: false, message: 'An OAuth token is required.' }
    }
    return probeMessagesEndpoint({ headers: { Authorization: `Bearer ${token}` } })
  }

  // claudeLogin — read the persisted session and probe with it.
  let session: ClaudeLocalSession
  try {
    session = readClaudeLocalSession()
  } catch (err) {
    return {
      ok: false,
      message: 'Could not read your Claude CLI session.',
      hint:
        (err as Error).message +
        ' Click Connect Claude to sign in, or switch to API key auth.',
    }
  }

  if (!session.accessToken) {
    return {
      ok: false,
      message: 'Claude is not signed in on this machine.',
      hint: 'Click Connect Claude to start the login flow.',
    }
  }

  if (session.expiresAt && session.expiresAt < Date.now()) {
    return {
      ok: false,
      message: 'Your Claude session has expired.',
      hint: 'Click Reconnect to refresh — the bundled Claude CLI does not auto-refresh in background.',
    }
  }

  const apiResult = await probeMessagesEndpoint({
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      'anthropic-beta': OAUTH_BETA_HEADER,
    },
  })

  if (apiResult.ok) {
    const account = formatAccount(session)
    return {
      ok: true,
      message: account ? `Claude session is valid (${account}).` : 'Claude session is valid.',
    }
  }

  // 401 against a freshly-minted-looking token is the bug pattern we
  // fixed for: the Claude CLI's `auth status` lies because the local
  // record is stale. Surface it explicitly so the user clicks Reconnect
  // instead of staring at a generic "auth failed".
  const checks: PluginTestCheck[] = [
    {
      name: 'Local session present',
      ok: true,
      message: session.accountEmail
        ? `Signed in as ${session.accountEmail}.`
        : 'Token loaded from local store.',
    },
    {
      name: 'Anthropic API accepts the token',
      ok: false,
      message: apiResult.message ?? 'Rejected by /v1/messages.',
      ...(apiResult.hint ? { hint: apiResult.hint } : {}),
    },
  ]

  return {
    ok: false,
    message:
      'Your Claude login looks active locally but Anthropic rejected the token.',
    hint:
      'This usually means a newer Claude session was created elsewhere and revoked this one. Click Reconnect to sign in again.',
    checks,
  }
}

// ── Probe ───────────────────────────────────────────────────────────────────

interface ProbeOptions {
  headers: Record<string, string>
}

async function probeMessagesEndpoint(opts: ProbeOptions): Promise<PluginTestResult> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...opts.headers,
  }
  let response: Response
  try {
    response = await fetch(`${ANTHROPIC_API}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })
  } catch (err) {
    return {
      ok: false,
      message: `Could not reach Anthropic API: ${(err as Error).message}`,
    }
  }

  if (response.ok) {
    return { ok: true, message: 'Anthropic API accepted the credential.' }
  }

  const detail = await describeFailure(response)
  const hint =
    response.status === 401
      ? 'The credential was rejected. Double-check the value — for API keys, that means starts with sk-ant- and was copied in full.'
      : response.status === 403
        ? 'The credential authenticated but does not have access to the Messages API.'
        : response.status === 429
          ? 'Rate limited. The credential is valid; finish setup and try again.'
          : undefined
  return {
    ok: false,
    message: `Anthropic ${detail}`,
    ...(hint ? { hint } : {}),
  }
}

async function describeFailure(response: Response): Promise<string> {
  const status = response.status
  const text = await response.text().catch(() => '')
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    parsed = null
  }
  const errorObj =
    parsed && typeof parsed === 'object' && 'error' in parsed
      ? (parsed as { error: { message?: string } }).error
      : null
  const msg = errorObj?.message ?? text.slice(0, 200) ?? 'Unknown error'
  return `HTTP ${status} — ${msg}`
}

// ── Local Claude session reader ─────────────────────────────────────────────

interface ClaudeLocalSession {
  accessToken: string | null
  refreshToken?: string | null
  expiresAt?: number
  scopes?: ReadonlyArray<string>
  accountEmail?: string
  organizationName?: string
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

function formatAccount(session: ClaudeLocalSession): string | null {
  if (session.accountEmail && session.organizationName) {
    return `${session.accountEmail} · ${session.organizationName}`
  }
  return session.accountEmail ?? session.organizationName ?? null
}
