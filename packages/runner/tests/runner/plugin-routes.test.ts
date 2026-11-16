import { describe, it, expect, afterEach, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import pino from 'pino'

const configStore = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))
const reloadRunnerState = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ updated: [], added: [], failed: [] }),
)

vi.mock('../../src/config/local-config', async importActual => ({
  ...(await importActual<typeof import('../../src/config/local-config')>()),
  loadLocalConfig: () => configStore.current,
  saveLocalConfig: (next: Record<string, unknown>) => {
    configStore.current = next
  },
}))
vi.mock('../../src/runner/config-reload', async importActual => ({
  ...(await importActual<typeof import('../../src/runner/config-reload')>()),
  reloadRunnerState,
}))

import { createRunnerServer } from '../../src/runner/server'
import type { PluginRegistry } from '../../src/plugins/registry'
import type { PluginRuntime } from '../../src/plugins/types'
import type { RunnerContext } from '../../src/jobs/runner'
import type { PluginHttpRoutesContext, PluginManifest } from '@coro-ai/plugin-sdk'

// The /system/reveal handler reads ~/.coro/config.json on construction-
// adjacent paths; we don't hit that endpoint here. Other routes also
// touch dispatcher/stateBackend, but the plugin-iteration block runs
// purely off `app` + the supplied helpers, so minimal stubs are fine.

function makeManifest(id: string): PluginManifest {
  return {
    id,
    kind: 'scm',
    displayName: id,
    version: '0.0.0',
    capabilities: {},
    configSchema: { type: 'object' },
  } as unknown as PluginManifest
}

function makePlugin(id: string, register: PluginRuntime['registerHttpRoutes']): PluginRuntime {
  return {
    manifest: makeManifest(id),
    init: vi.fn().mockResolvedValue(undefined),
    healthcheck: vi.fn().mockResolvedValue({ ok: true }),
    dispose: vi.fn().mockResolvedValue(undefined),
    registerHttpRoutes: register,
  }
}

function makeRegistry(
  plugins: PluginRuntime[],
  setupOnly: PluginRuntime[] = [],
): PluginRegistry {
  return {
    all: () => plugins,
    allSetupOnly: () => setupOnly,
    byId: (id: string) => [...plugins, ...setupOnly].find(p => p.manifest.id === id),
  } as unknown as PluginRegistry
}

const silentLogger = pino({ level: 'silent' })

const baseOpts = {
  port: 0,
  dispatcher: {} as never,
  stateBackend: {} as never,
  logger: silentLogger,
  mode: 'local' as const,
}

describe('createRunnerServer plugin HTTP route registration', () => {
  const closeFns: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const close of closeFns.splice(0)) await close()
  })

  async function startWithPlugins(
    plugins: PluginRuntime[],
    setupOnly: PluginRuntime[] = [],
    extra: { runnerCtx?: RunnerContext } = {},
  ) {
    // createRunnerServer already calls server.listen(port) internally;
    // we wait for the `listening` event before reading the bound port.
    const server = createRunnerServer({
      ...baseOpts,
      plugins: makeRegistry(plugins, setupOnly),
      ...extra,
    })
    if (!server.listening) {
      await new Promise<void>(resolve => server.once('listening', () => resolve()))
    }
    const port = (server.address() as AddressInfo).port
    closeFns.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    return { server, port }
  }

  it('mounts routes registered by a plugin via registerHttpRoutes', async () => {
    const plugin = makePlugin('test-plugin', ctx => {
      ctx.app.get('/config/test/ping', (..._args: unknown[]) => {
        const res = _args[1] as { json: (b: unknown) => void }
        res.json({ ok: true, source: 'test-plugin' })
      })
    })

    const { port } = await startWithPlugins([plugin])
    const response = await fetch(`http://127.0.0.1:${port}/config/test/ping`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, source: 'test-plugin' })
  })

  it('isolates plugin failures during registration so other plugins still mount', async () => {
    const bad = makePlugin('bad-plugin', () => {
      throw new Error('boom')
    })
    const good = makePlugin('good-plugin', ctx => {
      ctx.app.get('/config/good/ping', (..._args: unknown[]) => {
        const res = _args[1] as { json: (b: unknown) => void }
        res.json({ ok: true })
      })
    })

    const { port } = await startWithPlugins([bad, good])
    const response = await fetch(`http://127.0.0.1:${port}/config/good/ping`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('skips plugins that do not implement registerHttpRoutes', async () => {
    const plain = makePlugin('plain-plugin', undefined)
    delete (plain as { registerHttpRoutes?: unknown }).registerHttpRoutes

    // Should not throw at construction or listen.
    const { port } = await startWithPlugins([plain])
    const response = await fetch(`http://127.0.0.1:${port}/health`)
    expect(response.status).toBe(200)
  })

  // Setup-only plugins are the unconfigured ones. Their routes are how a user
  // configures them in the first place, so they must mount at boot — this is
  // the regression that made "Sign in with GitHub" 404 on a fresh install.
  it('mounts routes for setup-only plugins that are not yet configured', async () => {
    const unconfigured = makePlugin('unconfigured-plugin', ctx => {
      ctx.app.get('/config/plugins/unconfigured-plugin/auth/status', (..._args: unknown[]) => {
        const res = _args[1] as { json: (b: unknown) => void }
        res.json({ state: 'idle' })
      })
    })

    const { port } = await startWithPlugins([], [unconfigured])
    const response = await fetch(
      `http://127.0.0.1:${port}/config/plugins/unconfigured-plugin/auth/status`,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ state: 'idle' })
  })

  // A plugin's own sign-in route rotates its credentials through
  // savePluginConfig. Without a reload the running plugin kept the old
  // client, so "Sign in with GitHub" showed the new account while reviews
  // still read pull requests as the old one until a restart.
  it('reloads plugins when a route changes its saved config, and only then', async () => {
    configStore.current = {
      plugins: { installed: { 'signin-plugin': { enabled: true, config: { owner: 'old', token: 't1' } } } },
    }
    reloadRunnerState.mockClear()
    let routeCtx!: PluginHttpRoutesContext
    const plugin = makePlugin('signin-plugin', ctx => {
      routeCtx = ctx
    })
    const runnerCtx = { plugins: makeRegistry([plugin]) } as unknown as RunnerContext
    await startWithPlugins([plugin], [], { runnerCtx })

    await routeCtx.savePluginConfig('signin-plugin', { owner: 'old', token: 't1' })
    expect(reloadRunnerState).not.toHaveBeenCalled()

    await routeCtx.savePluginConfig('signin-plugin', { owner: 'new', token: 't2' })
    expect(reloadRunnerState).toHaveBeenCalledTimes(1)
    expect(configStore.current).toMatchObject({
      plugins: { installed: { 'signin-plugin': { config: { owner: 'new', token: 't2' } } } },
    })
  })
})
