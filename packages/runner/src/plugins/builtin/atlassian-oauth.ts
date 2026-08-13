// ── Shared Atlassian 3LO OAuth (Jira + Bitbucket) ────────────────────────────

import type { Request, Response } from 'express'
import type { PluginHttpRoutesContext } from '@coro-ai/plugin-sdk'
import {
  buildPkceAuthorizeUrl,
  exchangeAuthorizationCode,
  persistOAuthTokensPatch,
  pkceChallenge,
  startPkceLoopback,
} from '@coro-ai/plugin-sdk'
import { loadLocalConfig } from '../../config/local-config'

const ATLASSIAN_AUTH_URL = 'https://auth.atlassian.com/authorize'
const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token'

/** Register this callback URL in the Atlassian developer console (no port). */
export const ATLASSIAN_OAUTH_CALLBACK_URL = 'http://127.0.0.1/callback'

const SETUP_HINT =
  'Create an OAuth 2.0 (3LO) app at developer.atlassian.com, set the callback URL to http://127.0.0.1/callback, then enter your client ID below.'

type AtlassianFlow =
  | { state: 'idle' }
  | { state: 'pending'; authorizeUrl: string }
  | { state: 'success'; account?: { label: string } }
  | { state: 'error'; message: string }

const flows = new Map<string, AtlassianFlow>()

function idle(pluginId: string): AtlassianFlow {
  return flows.get(pluginId) ?? { state: 'idle' }
}

function readPluginConfig(pluginId: string): Record<string, unknown> {
  const cfg = loadLocalConfig()
  return (cfg?.plugins?.installed?.[pluginId]?.config ?? {}) as Record<string, unknown>
}

export function resolveAtlassianOAuthClientId(
  pluginId: string,
  overrides?: { oauthClientId?: unknown },
): string {
  const fromBody =
    typeof overrides?.oauthClientId === 'string' ? overrides.oauthClientId.trim() : ''
  if (fromBody) return fromBody

  const fromEnv = process.env['CORO_ATLASSIAN_OAUTH_CLIENT_ID']?.trim() ?? ''
  if (fromEnv) return fromEnv

  const fromConfig = readPluginConfig(pluginId)['oauthClientId']
  if (typeof fromConfig === 'string' && fromConfig.trim()) return fromConfig.trim()

  return ''
}

function oauthAvailability(pluginId: string, overrides?: { oauthClientId?: unknown }) {
  const clientId = resolveAtlassianOAuthClientId(pluginId, overrides)
  return {
    available: clientId.length > 0,
    setupHint: SETUP_HINT,
    callbackUrl: ATLASSIAN_OAUTH_CALLBACK_URL,
  }
}

function idleStatus(pluginId: string) {
  const availability = oauthAvailability(pluginId)
  return {
    state: 'idle' as const,
    ...availability,
    ...(availability.available
      ? {}
      : {
          message:
            'Atlassian OAuth is not configured yet. Create an app at developer.atlassian.com and enter your OAuth client ID below, or switch to API token auth.',
        }),
  }
}

export function registerAtlassianOAuthRoutes(
  ctx: PluginHttpRoutesContext,
  pluginId: string,
  scopes: string,
): void {
  const { app, logger, savePluginConfig } = ctx
  const base = `/config/plugins/${pluginId}/auth/atlassian-oauth`

  app.get(`${base}/status`, ((_req: Request, res: Response) => {
    const flow = idle(pluginId)
    if (flow.state === 'success') {
      res.json({ state: 'success', account: flow.account, available: true })
      return
    }
    if (flow.state === 'pending') {
      res.json({ state: 'pending', authorizeUrl: flow.authorizeUrl, available: true })
      return
    }
    if (flow.state === 'error') {
      res.json({
        state: 'error',
        message: flow.message,
        ...oauthAvailability(pluginId),
      })
      return
    }
    res.json(idleStatus(pluginId))
  }) as never)

  app.post(`${base}/start`, (async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { oauthClientId?: string }
      const clientId = resolveAtlassianOAuthClientId(pluginId, body)
      if (!clientId) {
        const err = {
          state: 'error' as const,
          message:
            'Atlassian OAuth is not configured. Set CORO_ATLASSIAN_OAUTH_CLIENT_ID, enter an OAuth client ID below, or use an API token.',
          ...oauthAvailability(pluginId),
        }
        flows.set(pluginId, { state: 'error', message: err.message })
        res.json(err)
        return
      }

      if (typeof body.oauthClientId === 'string' && body.oauthClientId.trim()) {
        savePluginConfig(pluginId, { oauthClientId: body.oauthClientId.trim() })
      }

      const loopback = await startPkceLoopback()
      const challenge = pkceChallenge(loopback.codeVerifier)
      const authorizeUrl = buildPkceAuthorizeUrl({
        authorizeUrl: ATLASSIAN_AUTH_URL,
        clientId,
        redirectUri: loopback.redirectUri,
        scope: scopes,
        state: loopback.state,
        codeChallenge: challenge,
      })
      flows.set(pluginId, { state: 'pending', authorizeUrl })
      res.json({ state: 'pending', authorizeUrl, available: true })

      void (async () => {
        try {
          const { code, state } = await loopback.waitForCode()
          if (state !== loopback.state) throw new Error('OAuth state mismatch')
          const tokens = await exchangeAuthorizationCode({
            tokenUrl: ATLASSIAN_TOKEN_URL,
            clientId,
            code,
            redirectUri: loopback.redirectUri,
            codeVerifier: loopback.codeVerifier,
          })
          const resources = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
            headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: 'application/json' },
          })
          const sites = resources.ok
            ? ((await resources.json()) as Array<{ url?: string; name?: string }>)
            : []
          const site = sites[0]
          const patch =
            pluginId === 'jira'
              ? {
                  baseUrl: site?.url ?? '',
                  username: site?.name ?? '',
                  apiToken: tokens.accessToken,
                  ...persistOAuthTokensPatch(tokens),
                }
              : {
                  workspace: site?.name ?? '',
                  coderUsername: site?.name ?? '',
                  coderToken: tokens.accessToken,
                  ...persistOAuthTokensPatch(tokens),
                }
          savePluginConfig(pluginId, patch)
          flows.set(pluginId, { state: 'success', account: { label: site?.name ?? pluginId } })
        } catch (err) {
          logger.warn({ err, pluginId }, 'Atlassian OAuth failed')
          flows.set(pluginId, {
            state: 'error',
            message: err instanceof Error ? err.message : String(err),
          })
        } finally {
          loopback.close()
        }
      })()
    } catch (err) {
      flows.set(pluginId, {
        state: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
      res.status(500).json({ state: 'error', message: (err as Error).message })
    }
  }) as never)
}
