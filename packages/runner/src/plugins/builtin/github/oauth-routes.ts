// ── GitHub browser sign-in (via GitHub CLI) ─────────────────────────────────
//
// Uses `gh auth login --web` so users never configure OAuth client IDs or
// environment variables. Requires the GitHub CLI on PATH; otherwise the
// dashboard steers users to install gh or use a personal access token.

import type { Request, Response } from 'express'
import type { PluginHttpRoutesContext, PluginOAuthStatus } from '@coro-ai/plugin-sdk'
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

/**
 * How long a confirmed session is trusted before the next status poll
 * revalidates it. Without this the dashboard keeps showing "connected" after
 * the user revokes the token or signs `gh` out; with it, a 2-second poll
 * doesn't hammer the GitHub API either.
 */
const SESSION_RECHECK_MS = 30_000
const lastVerifiedAt = new Map<string, number>()

/** Route segment for the method. Named for what it is: a gh-CLI web login. */
export const GITHUB_WEB_LOGIN_METHOD_ID = 'gh-cli-web'

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

/**
 * Read the current `gh` token, confirm it still works, and persist it.
 * Returns the login on success, null when there is no usable session.
 */
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
  lastVerifiedAt.set(pluginId, Date.now())
  return account.login
}

async function idleStatus(
  ctx: PluginHttpRoutesContext,
  pluginId: string,
  ownerConfigKey: string,
): Promise<PluginOAuthStatus> {
  const login = await persistGhSession(ctx, pluginId, ownerConfigKey)
  if (login) {
    flows.set(pluginId, { state: 'success', account: { label: login } })
    return { state: 'success', account: { label: login } }
  }

  const ghInstalled = await ghCommandExists()
  if (ghInstalled) return { state: 'idle', available: true }
  return {
    state: 'idle',
    available: false,
    code: 'setup_required',
    setupHint: GH_INSTALL_HINT,
    message: GH_INSTALL_HINT,
  }
}

export function registerGitHubOAuthRoutes(
  ctx: PluginHttpRoutesContext,
  options: GitHubOAuthRouteOptions,
): void {
  const { app, logger } = ctx
  const { pluginId, ownerConfigKey } = options
  const base = `/config/plugins/${pluginId}/auth/${GITHUB_WEB_LOGIN_METHOD_ID}`

  app.get(`${base}/status`, (async (_req: Request, res: Response) => {
    const flow = flowFor(pluginId)
    if (flow.state === 'success') {
      // Re-confirm periodically rather than latching success forever — a
      // revoked token or a `gh auth logout` should surface here, not at the
      // first job.
      const checkedAt = lastVerifiedAt.get(pluginId) ?? 0
      if (Date.now() - checkedAt < SESSION_RECHECK_MS) {
        res.json({ state: 'success', account: flow.account } satisfies PluginOAuthStatus)
        return
      }
      const login = await persistGhSession(ctx, pluginId, ownerConfigKey)
      if (login) {
        flows.set(pluginId, { state: 'success', account: { label: login } })
        res.json({ state: 'success', account: { label: login } } satisfies PluginOAuthStatus)
        return
      }
      flows.delete(pluginId)
      lastVerifiedAt.delete(pluginId)
      res.json(await idleStatus(ctx, pluginId, ownerConfigKey))
      return
    }
    if (flow.state === 'pending') {
      const login = await persistGhSession(ctx, pluginId, ownerConfigKey)
      if (login) {
        flows.set(pluginId, { state: 'success', account: { label: login } })
        res.json({ state: 'success', account: { label: login } } satisfies PluginOAuthStatus)
        return
      }
      res.json({ state: 'pending' } satisfies PluginOAuthStatus)
      return
    }
    if (flow.state === 'error') {
      res.json({ state: 'error', message: flow.message } satisfies PluginOAuthStatus)
      return
    }
    res.json(await idleStatus(ctx, pluginId, ownerConfigKey))
  }) as never)

  app.post(`${base}/start`, (async (_req: Request, res: Response) => {
    try {
      const existing = await persistGhSession(ctx, pluginId, ownerConfigKey)
      if (existing) {
        flows.set(pluginId, { state: 'success', account: { label: existing } })
        res.json({ state: 'success', account: { label: existing } } satisfies PluginOAuthStatus)
        return
      }

      const ghInstalled = await ghCommandExists()
      if (!ghInstalled) {
        const status: PluginOAuthStatus = {
          state: 'error',
          message: GH_INSTALL_HINT,
          code: 'setup_required',
          setupHint: GH_INSTALL_HINT,
          available: false,
        }
        flows.set(pluginId, { state: 'error', message: GH_INSTALL_HINT })
        res.json(status)
        return
      }

      flows.set(pluginId, { state: 'pending' })
      res.json({ state: 'pending' } satisfies PluginOAuthStatus)

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
      const message = err instanceof Error ? err.message : String(err)
      flows.set(pluginId, { state: 'error', message })
      res.status(500).json({ state: 'error', message } satisfies PluginOAuthStatus)
    }
  }) as never)
}
