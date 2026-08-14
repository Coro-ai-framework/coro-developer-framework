import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import pino from 'pino'
import { createRunnerServer } from '../../src/runner/server'
import type { PluginRegistry } from '../../src/plugins/registry'
import type { CredentialCandidate, PluginRuntime } from '../../src/plugins/types'
import type { PluginManifest } from '@coro-ai/plugin-sdk'

// The onboarding HTTP surface is what the FTUE wizard talks to, and two of its
// bugs shipped unnoticed because nothing exercised these routes: the redacted
// token was passed through to the plugin verbatim, and detect 500'd on a fresh
// install. Each test below pins one of those contracts.
//
// `os.homedir()` reads $HOME on POSIX, which is how these tests redirect
// `~/.coro/config.json` into a temp dir instead of the developer's own.

const silentLogger = pino({ level: 'silent' })

const PLUGIN_ID = 'probe-plugin'

interface FakePluginHandles {
  runtime: PluginRuntime
  /** Config handed to `testConnection`, i.e. after redaction fill. */
  lastTestedConfig: () => Record<string, unknown> | null
}

function makeFakePlugin(candidates: CredentialCandidate[] = []): FakePluginHandles {
  let lastTestedConfig: Record<string, unknown> | null = null
  const manifest = {
    id: PLUGIN_ID,
    kind: 'scm',
    displayName: 'Probe Plugin',
    version: '0.0.0',
    capabilities: {},
    configSchema: { type: 'object' },
  } as unknown as PluginManifest

  const runtime: PluginRuntime = {
    manifest,
    init: vi.fn().mockResolvedValue(undefined),
    healthcheck: vi.fn().mockResolvedValue({ ok: true }),
    dispose: vi.fn().mockResolvedValue(undefined),
    testConnection: async (config: Record<string, unknown>) => {
      lastTestedConfig = config
      return { ok: true, message: 'probed' }
    },
    detectCredentials: async () => candidates,
  } as unknown as PluginRuntime

  return { runtime, lastTestedConfig: () => lastTestedConfig }
}

function makeRegistry(configured: PluginRuntime[], setupOnly: PluginRuntime[] = []): PluginRegistry {
  return {
    all: () => configured,
    allSetupOnly: () => setupOnly,
    byId: (id: string) => configured.find(p => p.manifest.id === id),
    setupRuntime: (id: string) => setupOnly.find(p => p.manifest.id === id),
  } as unknown as PluginRegistry
}

describe('onboarding endpoints', () => {
  let tmpHome: string
  let priorHome: string | undefined
  let configPath: string
  const closeFns: Array<() => Promise<void>> = []

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-onboarding-test-'))
    priorHome = process.env.HOME
    process.env.HOME = tmpHome
    configPath = path.join(tmpHome, '.coro', 'config.json')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
  })

  afterEach(async () => {
    for (const close of closeFns.splice(0)) await close()
    if (priorHome === undefined) delete process.env.HOME
    else process.env.HOME = priorHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  async function start(registry: PluginRegistry): Promise<number> {
    const server = createRunnerServer({
      port: 0,
      dispatcher: {} as never,
      stateBackend: {} as never,
      logger: silentLogger,
      mode: 'local',
      plugins: registry,
    })
    if (!server.listening) {
      await new Promise<void>(resolve => server.once('listening', () => resolve()))
    }
    closeFns.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    return (server.address() as AddressInfo).port
  }

  function writeConfig(config: Record<string, unknown>): void {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  }

  function readConfig(): Record<string, unknown> {
    if (!fs.existsSync(configPath)) return {}
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
  }

  async function postJson(port: number, route: string, body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  describe('GET /config/plugins/catalog', () => {
    it('lists built-in providers with their auth descriptors on an empty config', async () => {
      const port = await start(makeRegistry([]))
      const response = await fetch(`http://127.0.0.1:${port}/config/plugins/catalog`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        plugins: Array<{ id: string; kind: string; authMethods: Array<{ kind: string; id: string }> }>
      }

      const github = body.plugins.find(p => p.id === 'github')
      expect(github?.kind).toBe('scm')
      // The wizard renders provider cards straight off these descriptors, so
      // an empty list here is an unusable SCM step.
      expect(github?.authMethods.length ?? 0).toBeGreaterThan(0)

      // Local mode is the zero-config escape hatch — it must be offered
      // before any account is connected.
      const local = body.plugins.find(p => p.id === 'local')
      expect(local).toBeDefined()
    })
  })

  describe('POST /test/plugin/:id', () => {
    it('swaps a masked secret for the stored one before probing', async () => {
      const realToken = 'ghp_thisisaverylongrealtoken'
      writeConfig({
        plugins: { installed: { [PLUGIN_ID]: { enabled: true, config: { token: realToken } } } },
      })
      const fake = makeFakePlugin()
      const port = await start(makeRegistry([fake.runtime]))

      // What the dashboard echoes back: the mask it was shown, not a secret.
      const masked = 'ghp_thisisav...oken'
      const response = await postJson(port, `/test/plugin/${PLUGIN_ID}`, {
        config: { token: masked, owner: 'octocat' },
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ ok: true, message: 'probed' })
      expect(fake.lastTestedConfig()).toEqual({ token: realToken, owner: 'octocat' })
    })

    it('reports an unknown plugin instead of failing the request', async () => {
      const port = await start(makeRegistry([]))
      const response = await postJson(port, '/test/plugin/does-not-exist', { config: {} })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ ok: false })
    })
  })

  describe('credential detection', () => {
    const candidate: CredentialCandidate = {
      id: 'cand-1',
      sourceLabel: 'GitHub CLI',
      accountHint: 'octocat',
      preview: [{ label: 'Account', value: 'octocat' }],
      config: { token: 'ghp_detected', owner: 'octocat' },
    }

    it('returns candidates from a plugin that is registered setup-only', async () => {
      const fake = makeFakePlugin([candidate])
      // Setup-only is the fresh-install state: no config, so no configured
      // runtime, but the route still has to answer.
      const port = await start(makeRegistry([], [fake.runtime]))

      const response = await postJson(port, `/config/plugins/${PLUGIN_ID}/auth/detect`, {})
      expect(response.status).toBe(200)
      const body = (await response.json()) as { candidates: Array<{ id: string; accountHint?: string }> }
      expect(body.candidates).toHaveLength(1)
      expect(body.candidates[0]).toMatchObject({ id: 'cand-1', accountHint: 'octocat' })
      // The token itself is never part of the preview payload.
      expect(JSON.stringify(body)).not.toContain('ghp_detected')
    })

    it('persists the chosen candidate and probes it', async () => {
      const fake = makeFakePlugin([candidate])
      // Applying a candidate writes config and hot-reloads, which promotes the
      // plugin from the setup-only tier to the configured one. The stub
      // registry mirrors that by resolving `byId` once config is on disk.
      const registry = {
        all: () => [],
        allSetupOnly: () => [fake.runtime],
        setupRuntime: (id: string) => (id === PLUGIN_ID ? fake.runtime : undefined),
        byId: (id: string) => {
          if (id !== PLUGIN_ID) return undefined
          const saved = readConfig() as {
            plugins?: { installed?: Record<string, unknown> }
          }
          return saved.plugins?.installed?.[PLUGIN_ID] ? fake.runtime : undefined
        },
      } as unknown as PluginRegistry
      const port = await start(registry)

      await postJson(port, `/config/plugins/${PLUGIN_ID}/auth/detect`, {})
      const response = await postJson(port, `/config/plugins/${PLUGIN_ID}/auth/detect/apply`, {
        candidateId: 'cand-1',
        overrides: { owner: 'acme-org' },
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ ok: true })

      const saved = readConfig() as {
        plugins?: { installed?: Record<string, { config?: Record<string, unknown> }> }
      }
      expect(saved.plugins?.installed?.[PLUGIN_ID]?.config).toMatchObject({
        token: 'ghp_detected',
        owner: 'acme-org',
      })
    })

    it('answers 410 when the candidate is no longer cached', async () => {
      const fake = makeFakePlugin([candidate])
      const port = await start(makeRegistry([], [fake.runtime]))

      const response = await postJson(port, `/config/plugins/${PLUGIN_ID}/auth/detect/apply`, {
        candidateId: 'never-detected',
      })
      expect(response.status).toBe(410)
      expect(await response.json()).toMatchObject({ ok: false })
    })

    it('answers with an empty candidate list for a plugin that cannot detect', async () => {
      const port = await start(makeRegistry([]))
      const response = await postJson(port, '/config/plugins/does-not-exist/auth/detect', {})
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ candidates: [] })
    })
  })

  // The onboarding routes belong to plugins that, by definition, have no
  // config yet on a fresh install. They used to 404 for exactly that reason.
  describe('fresh install', () => {
    it('mounts the GitHub setup routes with an empty config', async () => {
      const { buildBuiltinPluginRegistry } = await import('../../src/plugins/builtin')
      const registry = await buildBuiltinPluginRegistry({
        pluginsConfig: { installed: {} },
        logger: silentLogger,
      })
      const port = await start(registry)

      const detect = await postJson(port, '/config/plugins/github/auth/detect', {})
      expect(detect.status).toBe(200)
      expect(await detect.json()).toHaveProperty('candidates')

      const signIn = await fetch(
        `http://127.0.0.1:${port}/config/plugins/github/auth/gh-cli-web/status`,
      )
      expect(signIn.status).toBe(200)
      const status = (await signIn.json()) as { state: string }
      expect(['idle', 'success', 'pending', 'error']).toContain(status.state)
    })
  })
})
