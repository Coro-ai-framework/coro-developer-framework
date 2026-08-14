import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import pino from 'pino'
import { createRunnerServer } from '../../src/runner/server'
import type { PluginRegistry } from '../../src/plugins/registry'

// The upstream contribution destination is the one config section the
// dashboard writes that can publish to a public repository, so both
// directions of the round trip are worth pinning:
//
//   - GET must not hand the browser the raw GitHub token.
//   - PUT must actually persist the section (it silently did not, once),
//     and must not overwrite the stored token with the redacted string
//     the dashboard echoes back.
//
// `os.homedir()` reads $HOME on POSIX, which is how these tests redirect
// `~/.coro/config.json` into a temp dir instead of the developer's own.

const silentLogger = pino({ level: 'silent' })

const emptyRegistry = {
  all: () => [],
  allSetupOnly: () => [],
} as unknown as PluginRegistry

describe('GET/PUT /config — upstream contribution section', () => {
  let tmpHome: string
  let priorHome: string | undefined
  let configPath: string
  const closeFns: Array<() => Promise<void>> = []

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-config-test-'))
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

  async function start(): Promise<number> {
    const server = createRunnerServer({
      port: 0,
      dispatcher: {} as never,
      stateBackend: {} as never,
      logger: silentLogger,
      mode: 'local',
      plugins: emptyRegistry,
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
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
  }

  const UPSTREAM = {
    repoUrl: 'https://github.com/coro-ai-framework/coro',
    forkOwner: 'contributor',
    token: 'ghp_averyrealsecrettokenvalue',
    maxIssuesPerRun: 5,
    maxCodeJobsPerRun: 2,
  }

  async function getConfig(port: number) {
    const response = await fetch(`http://127.0.0.1:${port}/config`)
    expect(response.status).toBe(200)
    return (await response.json()) as {
      config: { upstream?: Record<string, unknown> } | null
      resolved: { upstreamConfigured?: boolean }
    }
  }

  async function putConfig(port: number, body: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return response
  }

  describe('GET', () => {
    it('redacts the token rather than shipping it to the browser', async () => {
      writeConfig({ upstream: UPSTREAM })
      const body = await getConfig(await start())

      expect(body.config?.upstream?.['token']).not.toBe(UPSTREAM.token)
      expect(String(body.config?.upstream?.['token'])).toContain('...')
      // Non-secret fields still round-trip so the form can show them.
      expect(body.config?.upstream?.['repoUrl']).toBe(UPSTREAM.repoUrl)
      expect(body.config?.upstream?.['forkOwner']).toBe('contributor')
      expect(body.config?.upstream?.['maxIssuesPerRun']).toBe(5)
    })

    it('reports the destination as configured', async () => {
      writeConfig({ upstream: UPSTREAM })
      const body = await getConfig(await start())
      expect(body.resolved.upstreamConfigured).toBe(true)
    })

    it('reports no destination when none is set', async () => {
      writeConfig({})
      const body = await getConfig(await start())
      expect(body.resolved.upstreamConfigured).toBe(false)
      expect(body.config?.upstream).toBeUndefined()
    })
  })

  describe('PUT', () => {
    it('persists a new destination', async () => {
      writeConfig({})
      const port = await start()

      const response = await putConfig(port, { upstream: UPSTREAM })
      expect(response.status).toBe(200)

      expect(readConfig()['upstream']).toEqual(UPSTREAM)
      expect((await getConfig(port)).resolved.upstreamConfigured).toBe(true)
    })

    it('keeps the stored token when the dashboard echoes the redacted one back', async () => {
      writeConfig({ upstream: UPSTREAM })
      const port = await start()

      const shown = (await getConfig(port)).config?.upstream?.['token']
      await putConfig(port, {
        upstream: { ...UPSTREAM, forkOwner: 'someone-else', token: shown },
      })

      const saved = readConfig()['upstream'] as Record<string, unknown>
      expect(saved['token']).toBe(UPSTREAM.token)
      expect(saved['forkOwner']).toBe('someone-else')
    })

    it('replaces the token when a real one is supplied', async () => {
      writeConfig({ upstream: UPSTREAM })
      const port = await start()

      await putConfig(port, { upstream: { ...UPSTREAM, token: 'ghp_rotated' } })
      expect((readConfig()['upstream'] as Record<string, unknown>)['token']).toBe('ghp_rotated')
    })

    it('turns contribution off when the repository URL is cleared', async () => {
      writeConfig({ upstream: UPSTREAM })
      const port = await start()

      // What the form sends after the operator empties the URL field. The
      // whole block goes, so a stale fork owner cannot make the next read
      // look configured.
      await putConfig(port, { upstream: { ...UPSTREAM, repoUrl: '' } })

      expect(readConfig()['upstream']).toBeUndefined()
      expect((await getConfig(port)).resolved.upstreamConfigured).toBe(false)
    })

    it('drops a blank count back to the runner default', async () => {
      writeConfig({ upstream: UPSTREAM })
      const port = await start()

      await putConfig(port, { upstream: { ...UPSTREAM, maxCodeJobsPerRun: null } })

      const saved = readConfig()['upstream'] as Record<string, unknown>
      expect(saved['maxCodeJobsPerRun']).toBeUndefined()
      expect(saved['maxIssuesPerRun']).toBe(5)
    })

    it('leaves other sections alone', async () => {
      writeConfig({ paths: { workingDir: '/tmp/work' } })
      const port = await start()

      await putConfig(port, { upstream: UPSTREAM })

      expect(readConfig()['paths']).toEqual({ workingDir: '/tmp/work' })
    })
  })
})
