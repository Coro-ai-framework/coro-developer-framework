// ── GitHub device-flow OAuth routes ─────────────────────────────────────────

import type { Request, Response } from 'express'
import type { PluginHttpRoutesContext } from '@coro-ai/plugin-sdk'
import {
  persistOAuthTokensPatch,
  pollDeviceFlowToken,
  startDeviceFlow,
} from '@coro-ai/plugin-sdk'

const GITHUB_DEVICE_AUTH_URL = 'https://github.com/login/device/code'
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const DEFAULT_CLIENT_ID = process.env['CORO_GITHUB_OAUTH_CLIENT_ID'] ?? 'Ov23liPLACEHOLDER'

type FlowState =
  | { state: 'idle' }
  | {
      state: 'pending'
      userCode: string
      verificationUri: string
      deviceCode: string
      clientId: string
      interval: number
      expiresIn: number
    }
  | { state: 'success'; account?: { label: string } }
  | { state: 'error'; message: string }

const flows = new Map<string, FlowState>()
const pollPromises = new Map<string, Promise<void>>()

export interface GitHubOAuthRouteOptions {
  pluginId: string
  /** Plugin config key for the GitHub account/org (e.g. `owner` or `defaultOwner`). */
  ownerConfigKey: string
}

function flowFor(pluginId: string): FlowState {
  return flows.get(pluginId) ?? { state: 'idle' }
}

export function registerGitHubOAuthRoutes(
  ctx: PluginHttpRoutesContext,
  options: GitHubOAuthRouteOptions,
): void {
  const { app, logger, savePluginConfig } = ctx
  const { pluginId, ownerConfigKey } = options
  const base = `/config/plugins/${pluginId}/auth/device-oauth`

  app.get(`${base}/status`, ((_req: Request, res: Response) => {
    const flow = flowFor(pluginId)
    if (flow.state === 'success') {
      res.json({
        state: 'success',
        account: flow.account,
      })
      return
    }
    if (flow.state === 'pending') {
      res.json({
        state: 'pending',
        userCode: flow.userCode,
        authorizeUrl: flow.verificationUri,
      })
      return
    }
    if (flow.state === 'error') {
      res.json({ state: 'error', message: flow.message })
      return
    }
    res.json({ state: 'idle' })
  }) as never)

  app.post(`${base}/start`, (async (req: Request, res: Response) => {
    try {
      const clientId =
        typeof (req as { body?: { clientId?: string } }).body?.clientId === 'string'
          ? (req as { body: { clientId: string } }).body.clientId
          : DEFAULT_CLIENT_ID
      if (!clientId || clientId.includes('PLACEHOLDER')) {
        const err = {
          state: 'error' as const,
          message:
            'GitHub device OAuth is not configured. Set CORO_GITHUB_OAUTH_CLIENT_ID or use a personal access token.',
        }
        flows.set(pluginId, err)
        res.json(err)
        return
      }
      const started = await startDeviceFlow({
        deviceAuthorizationUrl: GITHUB_DEVICE_AUTH_URL,
        clientId,
        scope: 'repo read:user',
      })
      flows.set(pluginId, {
        state: 'pending',
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        deviceCode: started.deviceCode,
        clientId,
        interval: started.interval,
        expiresIn: started.expiresIn,
      })
      res.json({
        state: 'pending',
        userCode: started.userCode,
        authorizeUrl: started.verificationUri,
      })

      if (pollPromises.has(pluginId)) return
      const pollPromise = (async () => {
        try {
          const tokens = await pollDeviceFlowToken({
            tokenUrl: GITHUB_TOKEN_URL,
            clientId,
            deviceCode: started.deviceCode,
            interval: started.interval,
            expiresIn: started.expiresIn,
            logger,
          })
          const userRes = await fetch('https://api.github.com/user', {
            headers: {
              Authorization: `Bearer ${tokens.accessToken}`,
              Accept: 'application/vnd.github+json',
              'User-Agent': 'coro-runner',
            },
          })
          const user = userRes.ok
            ? ((await userRes.json()) as { login?: string })
            : {}
          savePluginConfig(pluginId, {
            [ownerConfigKey]: user.login ?? '',
            token: tokens.accessToken,
            ...persistOAuthTokensPatch(tokens),
          })
          flows.set(pluginId, {
            state: 'success',
            account: { label: user.login ?? 'GitHub' },
          })
        } catch (err) {
          flows.set(pluginId, {
            state: 'error',
            message: err instanceof Error ? err.message : String(err),
          })
        } finally {
          pollPromises.delete(pluginId)
        }
      })()
      pollPromises.set(pluginId, pollPromise)
    } catch (err) {
      flows.set(pluginId, {
        state: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
      res.status(500).json({ state: 'error', message: (err as Error).message })
    }
  }) as never)
}
