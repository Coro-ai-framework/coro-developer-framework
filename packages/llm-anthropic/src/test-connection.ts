// ── Anthropic credential probe ──────────────────────────────────────────────
//
// Active "does this auth actually work?" check, invoked by the dashboard's
// "Test connection" button (Settings + FTUE) via `POST /test/plugin/:id` →
// `AnthropicExecutor.testConnection()`. Distinct from `healthcheck()`,
// which is a passive shape-only check.
//
// Why this lives in the plugin (not the runner): every LLM provider has
// its own auth shape, base URL, and beta headers. Putting the probe here
// means `server.ts` carries zero Anthropic-specific code — adding a new
// LLM plugin requires zero edits to the runner.
//
// Token validity is model-agnostic. We round-trip against `GET /v1/models`
// (list, no inference, no model id) rather than `POST /v1/messages`. A
// Messages ping has to name a live model, and Anthropic's OAuth
// entitlement gate then further requires Claude Code identity scaffolding
// that has nothing to do with whether the token is good. When the catalogue
// model used for that ping retires, Connect Claude starts failing for
// every valid login — which is what happened when the probe moved off
// Haiku onto Sonnet 5. Listing models does not have that coupling.
//
// The `claudeLogin` branch still does NOT trust the Claude CLI's own
// `auth status` (which reports `loggedIn: true` even when the API
// rejects the token — observed bug). It pulls the OAuth access token
// out of the platform credential store and asks Anthropic whether that
// token is accepted.
//
// Because that probe gates job execution (via
// `AnthropicExecutor.assertAuthReadyForSdk`), it must renew an expired
// session rather than fail on it. Anthropic's claude.ai access tokens last
// 8 hours, so a runner that idles overnight will always find an expired
// token — treating that as fatal is what used to demand a manual
// "Reconnect" every morning. Expiry and a 401 now trigger a refresh and
// one retry; only a session that cannot be renewed is a failure.

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

/**
 * Run a live credential probe against Anthropic and return a structured
 * result the dashboard can render directly. Branches on `auth.method`:
 *
 *   - `apiKey`     → GET /v1/models with `x-api-key`.
 *   - `oauth`      → GET /v1/models with `Authorization: Bearer …`
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
    return probeCredential({ headers: { 'x-api-key': apiKey } })
  }

  if (method === 'oauth') {
    const token = (auth.oauthToken ?? '').trim()
    if (!token) {
      return { ok: false, message: 'An OAuth token is required.' }
    }
    return probeCredential({ headers: oauthHeaders(token) })
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

  let apiResult = await probeCredential({ headers: oauthHeaders(session.accessToken) })

  // A 401 on an unexpired token means the stored copy went stale — most
  // often because a concurrent Claude Code process refreshed the session and
  // rotated this access token out from under us. Renew once and retry before
  // calling it a failure. Other statuses (403/429/5xx) are not "bad token".
  let renewed = false
  if (!apiResult.ok && apiResult.status === 401 && (await refreshClaudeLocalSession())) {
    renewed = true
    try {
      session = readClaudeLocalSession()
    } catch {
      // Keep the session we already have and report the original failure.
    }
    if (session.accessToken) {
      apiResult = await probeCredential({ headers: oauthHeaders(session.accessToken) })
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
      message: apiResult.message ?? 'Rejected by Anthropic.',
      ...(apiResult.hint ? { hint: apiResult.hint } : {}),
    },
  ]

  if (apiResult.status === 401) {
    return {
      ok: false,
      message: renewed
        ? 'Your Claude login looks active locally but Anthropic rejected the token, and renewing it did not help.'
        : 'Your Claude login looks active locally but Anthropic rejected the token.',
      hint: 'This usually means the session was revoked — for example by signing in elsewhere. Click Reconnect to sign in again.',
      checks,
    }
  }

  return {
    ok: false,
    message: apiResult.message ?? 'Anthropic did not accept the credential.',
    ...(apiResult.hint ? { hint: apiResult.hint } : {}),
    checks,
  }
}

// ── Probe ───────────────────────────────────────────────────────────────────

interface ProbeOptions {
  headers: Record<string, string>
}

interface ProbeResult extends PluginTestResult {
  /** HTTP status from Anthropic, when a response arrived. */
  status?: number
}

function oauthHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': OAUTH_BETA_HEADER,
  }
}

/**
 * Ask Anthropic whether this credential is accepted, without naming a
 * model or spending inference tokens. `GET /v1/models` is the auth
 * round-trip; it stays valid as the catalogue turns over.
 */
async function probeCredential(opts: ProbeOptions): Promise<ProbeResult> {
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    ...opts.headers,
  }
  let response: Response
  try {
    response = await fetch(`${ANTHROPIC_API}/v1/models`, {
      method: 'GET',
      headers,
    })
  } catch (err) {
    return {
      ok: false,
      message: `Could not reach Anthropic API: ${(err as Error).message}`,
    }
  }

  if (response.ok) {
    return { ok: true, status: response.status, message: 'Anthropic API accepted the credential.' }
  }

  const status = response.status
  const detail = await describeFailure(response)
  const hint =
    status === 401
      ? 'The credential was rejected. Double-check the value — for API keys, that means starts with sk-ant- and was copied in full.'
      : status === 403
        ? 'The credential authenticated but does not have access to list models.'
        : status === 429
          ? 'Rate limited. The credential is valid; finish setup and try again.'
          : undefined
  return {
    ok: false,
    status,
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
