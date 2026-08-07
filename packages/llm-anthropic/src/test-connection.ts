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
//
// Because that probe gates job execution (via
// `AnthropicExecutor.assertAuthReadyForSdk`), it must renew an expired
// session rather than fail on it. Anthropic's claude.ai access tokens last
// 8 hours, so a runner that idles overnight will always find an expired
// token — treating that as fatal is what used to demand a manual
// "Reconnect" every morning. Both the expiry check and a 401 now trigger a
// refresh and one retry; only a session that cannot be renewed is a failure.

import type { PluginTestCheck, PluginTestResult } from '@coro-ai/plugin-sdk'
import {
  isSessionExpired,
  loadClaudeLocalSession,
  readClaudeLocalSession,
  refreshClaudeLocalSession,
  type ClaudeLocalSession,
} from './credential-store'
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
/** Turn a failed {@link testAnthropicCredentials} result into a user-facing error. */
export function formatAnthropicAuthFailure(result: PluginTestResult): string {
  const parts = [result.message]
  if (result.hint) parts.push(result.hint)
  return parts.filter(Boolean).join(' ')
}

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

  // claudeLogin — read the persisted session, renewing it if it has aged
  // out, and probe with the result.
  let session: ClaudeLocalSession
  try {
    session = await loadClaudeLocalSession()
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

  if (isSessionExpired(session.expiresAt)) {
    // `loadClaudeLocalSession` already tried to renew this, so the refresh
    // token is missing, rejected, or expired too. That needs a real login.
    return {
      ok: false,
      message: 'Your Claude session has expired and could not be renewed.',
      hint: 'Click Reconnect to sign in again.',
    }
  }

  let apiResult = await probeMessagesEndpoint({
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      'anthropic-beta': OAUTH_BETA_HEADER,
    },
  })

  // A rejected but unexpired token means the stored copy went stale — most
  // often because a concurrent Claude Code process refreshed the session and
  // rotated this access token out from under us. Renew once and retry before
  // calling it a failure.
  if (!apiResult.ok && (await refreshClaudeLocalSession())) {
    try {
      session = readClaudeLocalSession()
    } catch {
      // Keep the session we already have and report the original failure.
    }
    if (session.accessToken) {
      apiResult = await probeMessagesEndpoint({
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
        },
      })
    }
  }

  if (apiResult.ok) {
    const account = formatAccount(session)
    return {
      ok: true,
      message: account ? `Claude session is valid (${account}).` : 'Claude session is valid.',
    }
  }

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
      'Your Claude login looks active locally but Anthropic rejected the token, and renewing it did not help.',
    hint:
      'This usually means the session was revoked — for example by signing in elsewhere. Click Reconnect to sign in again.',
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

function formatAccount(session: ClaudeLocalSession): string | null {
  if (session.accountEmail && session.organizationName) {
    return `${session.accountEmail} · ${session.organizationName}`
  }
  return session.accountEmail ?? session.organizationName ?? null
}
