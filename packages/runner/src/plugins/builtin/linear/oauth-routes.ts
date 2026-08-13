// ── Linear PKCE loopback OAuth ──────────────────────────────────────────────

import type { Request, Response } from 'express'
import type { PluginHttpRoutesContext } from '@coro-ai/plugin-sdk'
import {
  buildPkceAuthorizeUrl,
  exchangeAuthorizationCode,
  persistOAuthTokensPatch,
  pkceChallenge,
  startPkceLoopback,
} from '@coro-ai/plugin-sdk'

const LINEAR_AUTH_URL = 'https://linear.app/oauth/authorize'
const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token'
const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql'
const DEFAULT_CLIENT_ID = process.env['CORO_LINEAR_OAUTH_CLIENT_ID'] ?? ''

type LinearFlow =
  | { state: 'idle' }
  | { state: 'pending'; authorizeUrl: string }
  | { state: 'success'; account?: { label: string } }
  | { state: 'error'; message: string }

let flow: LinearFlow = { state: 'idle' }

export function registerLinearOAuthRoutes(ctx: PluginHttpRoutesContext): void {
  const { app, logger, savePluginConfig } = ctx
  const base = '/config/plugins/linear/auth/oauth'

  app.get(`${base}/status`, ((_req: Request, res: Response) => {
    if (flow.state === 'success') {
      res.json({ state: 'success', account: flow.account })
      return
    }
    if (flow.state === 'pending') {
      res.json({ state: 'pending', authorizeUrl: flow.authorizeUrl })
      return
    }
    if (flow.state === 'error') {
      res.json({ state: 'error', message: flow.message })
      return
    }
    res.json({ state: 'idle' })
  }) as never)

  app.post(`${base}/start`, (async (_req: Request, res: Response) => {
    try {
      const clientId = DEFAULT_CLIENT_ID
      if (!clientId) {
        flow = {
          state: 'error',
          message: 'Linear OAuth is not configured. Set CORO_LINEAR_OAUTH_CLIENT_ID or use an API key.',
        }
        res.json(flow)
        return
      }
      const loopback = await startPkceLoopback()
      const challenge = pkceChallenge(loopback.codeVerifier)
      const authorizeUrl = buildPkceAuthorizeUrl({
        authorizeUrl: LINEAR_AUTH_URL,
        clientId,
        redirectUri: loopback.redirectUri,
        scope: 'read,write,issues:create,comments:create',
        state: loopback.state,
        codeChallenge: challenge,
      })
      flow = { state: 'pending', authorizeUrl }
      res.json({ state: 'pending', authorizeUrl })

      void (async () => {
        try {
          const { code, state } = await loopback.waitForCode()
          if (state !== loopback.state) throw new Error('OAuth state mismatch')
          const tokens = await exchangeAuthorizationCode({
            tokenUrl: LINEAR_TOKEN_URL,
            clientId,
            code,
            redirectUri: loopback.redirectUri,
            codeVerifier: loopback.codeVerifier,
          })
          const viewerRes = await fetch(LINEAR_GRAPHQL_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${tokens.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query: '{ viewer { id name email } }' }),
          })
          const viewerJson = viewerRes.ok
            ? ((await viewerRes.json()) as { data?: { viewer?: { name?: string; email?: string } } })
            : {}
          const viewer = viewerJson.data?.viewer
          const label = viewer?.email ?? viewer?.name ?? 'Linear'
          savePluginConfig('linear', {
            apiKey: tokens.accessToken,
            ...persistOAuthTokensPatch(tokens),
          })
          flow = { state: 'success', account: { label } }
        } catch (err) {
          logger.warn({ err }, 'Linear OAuth failed')
          flow = {
            state: 'error',
            message: err instanceof Error ? err.message : String(err),
          }
        } finally {
          loopback.close()
        }
      })()
    } catch (err) {
      flow = {
        state: 'error',
        message: err instanceof Error ? err.message : String(err),
      }
      res.status(500).json({ state: 'error', message: flow.message })
    }
  }) as never)
}
