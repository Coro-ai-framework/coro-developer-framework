// ── Shared OAuth helpers for SCM / tracker plugins ───────────────────────────
//
// Device-flow poller, PKCE + localhost loopback, token persistence, and a
// refresh-before-use wrapper. Plugins compose these; the runner core never
// sees provider-specific endpoints.

import type { Logger } from 'pino'
import { createServer, type Server } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
}

export interface DeviceFlowStartResult {
  deviceCode: string
  userCode: string
  verificationUri: string
  interval: number
  expiresIn: number
}

export async function startDeviceFlow(args: {
  deviceAuthorizationUrl: string
  clientId: string
  scope?: string
  fetchFn?: typeof fetch
}): Promise<DeviceFlowStartResult> {
  const fetchFn = args.fetchFn ?? globalThis.fetch
  const body = new URLSearchParams({
    client_id: args.clientId,
    ...(args.scope ? { scope: args.scope } : {}),
  })
  const res = await fetchFn(args.deviceAuthorizationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  })
  if (!res.ok) {
    throw new Error(`Device authorization failed (${res.status})`)
  }
  const json = (await res.json()) as Record<string, unknown>
  return {
    deviceCode: String(json['device_code'] ?? ''),
    userCode: String(json['user_code'] ?? ''),
    verificationUri: String(json['verification_uri'] ?? json['verification_uri_complete'] ?? ''),
    interval: Number(json['interval'] ?? 5),
    expiresIn: Number(json['expires_in'] ?? 900),
  }
}

export async function pollDeviceFlowToken(args: {
  tokenUrl: string
  clientId: string
  deviceCode: string
  interval: number
  expiresIn: number
  fetchFn?: typeof fetch
  logger?: Logger
}): Promise<OAuthTokens> {
  const fetchFn = args.fetchFn ?? globalThis.fetch
  const deadline = Date.now() + args.expiresIn * 1000
  let intervalMs = Math.max(args.interval, 5) * 1000

  while (Date.now() < deadline) {
    await sleep(intervalMs)
    const body = new URLSearchParams({
      client_id: args.clientId,
      device_code: args.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    const res = await fetchFn(args.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    })
    const json = (await res.json()) as Record<string, unknown>
    if (res.ok && typeof json['access_token'] === 'string') {
      const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : undefined
      return {
        accessToken: json['access_token'] as string,
        refreshToken: typeof json['refresh_token'] === 'string' ? (json['refresh_token'] as string) : undefined,
        expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
      }
    }
    const err = String(json['error'] ?? '')
    if (err === 'slow_down') {
      intervalMs += 5000
      continue
    }
    if (err === 'authorization_pending') continue
    throw new Error(String(json['error_description'] ?? err ?? 'Device flow failed'))
  }
  throw new Error('Device flow timed out')
}

export interface PkceLoopbackResult {
  redirectUri: string
  state: string
  codeVerifier: string
  waitForCode: () => Promise<{ code: string; state: string }>
  close: () => void
}

/**
 * Bind a loopback listener and hand back the redirect URI the provider must
 * call back on.
 *
 * The port is ephemeral by default, so the redirect URI changes between runs.
 * Providers that require the callback URL to be registered up-front (Atlassian
 * among them) only accept an exact match, so those flows must pass a fixed
 * `port` and register that same URL — `http://127.0.0.1/callback` without a
 * port will never match what this binds.
 */
export async function startPkceLoopback(args?: {
  port?: number
  timeoutMs?: number
}): Promise<PkceLoopbackResult> {
  const timeoutMs = args?.timeoutMs ?? 5 * 60 * 1000
  const codeVerifier = base64Url(randomBytes(32))
  const state = base64Url(randomBytes(16))

  let server: Server | null = null
  let resolveWait: ((v: { code: string; state: string }) => void) | null = null
  let rejectWait: ((err: Error) => void) | null = null
  // The browser can hit the callback more than once (favicon, a reload, a
  // retry from the provider). Only the first outcome counts; later ones must
  // not resolve a promise that already settled.
  let settled = false

  const waitPromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolveWait = resolve
    rejectWait = reject
  })

  const finish = (outcome: { code: string; state: string } | Error): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (outcome instanceof Error) rejectWait?.(outcome)
    else resolveWait?.(outcome)
    server?.close()
  }

  const timer = setTimeout(() => {
    finish(new Error('OAuth loopback timed out'))
  }, timeoutMs)

  const redirectUri = await new Promise<string>((resolve, reject) => {
    server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const code = url.searchParams.get('code')
        const returnedState = url.searchParams.get('state') ?? ''
        // A denied consent screen redirects with `error`, no `code`. Without
        // this the caller waits out the full timeout for an answer that has
        // already arrived.
        const error = url.searchParams.get('error')
        if (error) {
          const description = url.searchParams.get('error_description')
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end('<html><body><p>Authorization failed. You can close this tab.</p></body></html>')
          finish(new Error(description ?? error))
          return
        }
        if (!code) {
          res.writeHead(400)
          res.end('Missing code')
          finish(new Error('OAuth callback arrived without an authorization code'))
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><p>Connected. You can close this tab.</p></body></html>')
        finish({ code, state: returnedState })
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)))
      }
    })
    const listenPort = args?.port ?? 0
    server.listen(listenPort, '127.0.0.1', () => {
      const addr = server!.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('Could not bind loopback port'))
        return
      }
      resolve(`http://127.0.0.1:${addr.port}/callback`)
    })
    server.on('error', reject)
  })

  return {
    redirectUri,
    state,
    codeVerifier,
    waitForCode: () => waitPromise,
    close: () => {
      clearTimeout(timer)
      server?.close()
    },
  }
}

export function buildPkceAuthorizeUrl(args: {
  authorizeUrl: string
  clientId: string
  redirectUri: string
  scope: string
  state: string
  codeChallenge: string
}): string {
  const url = new URL(args.authorizeUrl)
  url.searchParams.set('client_id', args.clientId)
  url.searchParams.set('redirect_uri', args.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', args.scope)
  url.searchParams.set('state', args.state)
  url.searchParams.set('code_challenge', args.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

export async function exchangeAuthorizationCode(args: {
  tokenUrl: string
  clientId: string
  code: string
  redirectUri: string
  codeVerifier: string
  clientSecret?: string
  fetchFn?: typeof fetch
}): Promise<OAuthTokens> {
  const fetchFn = args.fetchFn ?? globalThis.fetch
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: args.clientId,
    code: args.code,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
    ...(args.clientSecret ? { client_secret: args.clientSecret } : {}),
  })
  const res = await fetchFn(args.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  })
  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok || typeof json['access_token'] !== 'string') {
    throw new Error(String(json['error_description'] ?? json['error'] ?? 'Token exchange failed'))
  }
  const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : undefined
  return {
    accessToken: json['access_token'] as string,
    refreshToken: typeof json['refresh_token'] === 'string' ? (json['refresh_token'] as string) : undefined,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
  }
}

export function persistOAuthTokensPatch(tokens: OAuthTokens): Record<string, unknown> {
  return {
    oauthAccessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { oauthRefreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresAt ? { oauthExpiresAt: tokens.expiresAt } : {}),
  }
}

const REFRESH_FAILURE_COOLDOWN_MS = 60_000

interface RefreshState {
  inFlight: Promise<boolean> | null
  lastFailureAt: number | null
}

// Keyed per caller: with a single module-level pair, one plugin's failed
// refresh put every other plugin into a cooldown, and two plugins refreshing
// at once shared a promise resolved with the wrong provider's result.
const refreshStateByScope = new Map<string, RefreshState>()

export async function refreshOAuthTokenIfNeeded(args: {
  expiresAt?: number
  refreshToken?: string
  refresh: (refreshToken: string) => Promise<OAuthTokens>
  save: (tokens: OAuthTokens) => void
  logger?: Logger
  /** Coalescing/cooldown scope — pass the plugin id (and account, if the
   * plugin holds several). Callers that omit it share one bucket. */
  scope?: string
}): Promise<boolean> {
  if (!args.expiresAt || !args.refreshToken) return false
  if (Date.now() + 60_000 < args.expiresAt) return true

  const key = args.scope ?? 'default'
  const state = refreshStateByScope.get(key) ?? { inFlight: null, lastFailureAt: null }
  refreshStateByScope.set(key, state)

  if (state.inFlight) return state.inFlight
  if (
    state.lastFailureAt !== null
    && Date.now() - state.lastFailureAt < REFRESH_FAILURE_COOLDOWN_MS
  ) {
    return false
  }
  state.inFlight = args.refresh(args.refreshToken)
    .then(tokens => {
      args.save(tokens)
      state.lastFailureAt = null
      return true
    })
    .catch(err => {
      args.logger?.warn({ err, scope: key }, 'oauth.refresh failed')
      state.lastFailureAt = Date.now()
      return false
    })
    .finally(() => {
      state.inFlight = null
    })
  return state.inFlight
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64url')
}

export function pkceChallenge(codeVerifier: string): string {
  return base64Url(createHash('sha256').update(codeVerifier).digest())
}
