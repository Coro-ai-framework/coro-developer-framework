// ── GitHub browser sign-in (via GitHub CLI) ─────────────────────────────────
//
// Uses `gh auth login --web` so users never configure OAuth client IDs or
// environment variables. Requires the GitHub CLI on PATH; otherwise the
// dashboard steers users to install gh or use a PAT.

import type { Request, Response } from 'express'
import type { PluginHttpRoutesContext } from '@coro-ai/plugin-sdk'
import {
  ghCommandExists,
  tryGhAuthToken,
  validateGithubToken,
  waitForGhWebLogin,
} from './gh-session'

type FlowState =
  | { state: 'idle' }
  | { state: 'pending' }
  | { state: 'success'; account?: { label: string } }
  | { state: 'error'; message: string }

const flows = new Map<string, FlowState>()
const loginPromises = new Map<string, Promise<void>>()

export interface GitHubOAuthRouteOptions {
  pluginId: string
  /** Plugin config key for the GitHub account/org (e.g. `owner` or `defaultOwner`). */
  ownerConfigKey: string
}

function flowFor(pluginId: string): FlowState {
  return flows.get(pluginId) ?? { state: 'idle' }
}

const GH_INSTALL_HINT =
  'Install the GitHub CLI (https://cli.github.com) to sign in with your browser, or switch to a personal access token.'

async function persistGhSession(
  ctx: PluginHttpRoutesContext,
  pluginId: string,
  ownerConfigKey: string,
): Promise<string | null> {
  const token = await tryGhAuthToken()
  if (!token) return null
  const account = await validateGithubToken(globalThis.fetch, token)
  if (!account) return null
  ctx.savePluginConfig(pluginId, {
    [ownerConfigKey]: account.login,
    token,
  })
  return account.login
}

async function idleStatus(
  ctx: PluginHttpRoutesContext,
  pluginId: string,
  ownerConfigKey: string,
) {
  const login = await persistGhSession(ctx, pluginId, ownerConfigKey)
  if (login) {
    flows.set(pluginId, { state: 'success', account: { label: login } })
    return { state: 'success' as const, account: { label: login } }
  }

  const ghInstalled = await ghCommandExists()
  return {
    state: 'idle' as const,
    available: ghInstalled,
    ...(ghInstalled
      ? {}
      : {
          setupHint: GH_INSTALL_HINT,
          message: GH_INSTALL_HINT,
        }),
  }
}

export function registerGitHubOAuthRoutes(
  ctx: PluginHttpRoutesContext,
  options: GitHubOAuthRouteOptions,
): void {
  const { app, logger } = ctx
  const { pluginId, ownerConfigKey } = options
  const base = `/config/plugins/${pluginId}/auth/device-oauth`

  app.get(`${base}/status`, (async (_req: Request, res: Response) => {
    const flow = flowFor(pluginId)
    if (flow.state === 'success') {
      res.json({
        state: 'success',
        account: flow.account,
      })
      return
    }
    if (flow.state === 'pending') {
      const login = await persistGhSession(ctx, pluginId, ownerConfigKey)
      if (login) {
        flows.set(pluginId, { state: 'success', account: { label: login } })
        res.json({ state: 'success', account: { label: login } })
        return
      }
      res.json({ state: 'pending' })
      return
    }
    if (flow.state === 'error') {
      res.json({ state: 'error', message: flow.message })
      return
    }
    res.json(await idleStatus(ctx, pluginId, ownerConfigKey))
  }) as never)

  app.post(`${base}/start`, (async (_req: Request, res: Response) => {
    try {
      const existing = await persistGhSession(ctx, pluginId, ownerConfigKey)
      if (existing) {
        flows.set(pluginId, { state: 'success', account: { label: existing } })
        res.json({ state: 'success', account: { label: existing } })
        return
      }

      const ghInstalled = await ghCommandExists()
      if (!ghInstalled) {
        const err = { state: 'error' as const, message: GH_INSTALL_HINT, available: false }
        flows.set(pluginId, err)
        res.json(err)
        return
      }

      flows.set(pluginId, { state: 'pending' })
      res.json({ state: 'pending' })

      if (loginPromises.has(pluginId)) return
      const loginPromise = (async () => {
        try {
          await waitForGhWebLogin()
          const login = await persistGhSession(ctx, pluginId, ownerConfigKey)
          if (!login) {
            throw new Error('GitHub sign-in finished but no token was found. Try again.')
          }
          flows.set(pluginId, { state: 'success', account: { label: login } })
        } catch (err) {
          logger.warn({ err, pluginId }, 'github gh web login failed')
          flows.set(pluginId, {
            state: 'error',
            message: err instanceof Error ? err.message : String(err),
          })
        } finally {
          loginPromises.delete(pluginId)
        }
      })()
      loginPromises.set(pluginId, loginPromise)
    } catch (err) {
      flows.set(pluginId, {
        state: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
      res.status(500).json({ state: 'error', message: (err as Error).message })
    }
  }) as never)
}
