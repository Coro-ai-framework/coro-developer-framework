import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import pino from 'pino'
import { createRunnerServer } from '../../src/runner/server'
import type { PluginRegistry } from '../../src/plugins/registry'

const silentLogger = pino({ level: 'silent' })

const emptyRegistry = {
  all: () => [],
  allSetupOnly: () => [],
} as unknown as PluginRegistry

describe('GET/PUT /config — decision layer section', () => {
  let tmpHome: string
  let priorHome: string | undefined
  let configPath: string
  const closeFns: Array<() => Promise<void>> = []

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-decision-config-'))
    priorHome = process.env.HOME
    process.env.HOME = tmpHome
    configPath = path.join(tmpHome, '.coro', 'config.json')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    delete process.env.CORO_DECISION_MODE
    delete process.env.CORO_DECISION_API_KEY
    delete process.env.TYPESAFE_API_KEY
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

  const DECISION = {
    mode: 'shadow',
    apiKey: 'sk-averyrealsecretdecisionkey',
    model: 'jev-1.13.0',
    overseer: { scope: 'all', onFlag: 'park' },
  }

  async function getConfig(port: number) {
    const response = await fetch(`http://127.0.0.1:${port}/config`)
    expect(response.status).toBe(200)
    return (await response.json()) as {
      config: { decision?: Record<string, unknown> } | null
      resolved: { decisionConfigured?: boolean }
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
    it('redacts the apiKey rather than shipping it to the browser', async () => {
      writeConfig({ decision: DECISION })
      const body = await getConfig(await start())

      expect(body.config?.decision?.['apiKey']).not.toBe(DECISION.apiKey)
      expect(String(body.config?.decision?.['apiKey'])).toContain('...')
      expect(body.config?.decision?.['mode']).toBe('shadow')
      expect(body.config?.decision?.['model']).toBe('jev-1.13.0')
    })

    it('reports the layer as configured when mode and key are set', async () => {
      writeConfig({ decision: DECISION })
      const body = await getConfig(await start())
      expect(body.resolved.decisionConfigured).toBe(true)
    })

    it('reports the layer as off when none is set', async () => {
      writeConfig({})
      const body = await getConfig(await start())
      expect(body.resolved.decisionConfigured).toBe(false)
      expect(body.config?.decision).toBeUndefined()
    })
  })

  describe('PUT', () => {
    it('persists a new decision block', async () => {
      writeConfig({})
      const port = await start()

      const response = await putConfig(port, { decision: DECISION })
      expect(response.status).toBe(200)

      expect(readConfig()['decision']).toMatchObject(DECISION)
      expect((await getConfig(port)).resolved.decisionConfigured).toBe(true)
    })

    it('keeps the stored apiKey when the dashboard echoes the redacted one back', async () => {
      writeConfig({ decision: DECISION })
      const port = await start()

      const shown = (await getConfig(port)).config?.decision?.['apiKey']
      await putConfig(port, {
        decision: { ...DECISION, mode: 'live', apiKey: shown },
      })

      const saved = readConfig()['decision'] as Record<string, unknown>
      expect(saved['apiKey']).toBe(DECISION.apiKey)
      expect(saved['mode']).toBe('live')
    })

    it('replaces the apiKey when a real one is supplied', async () => {
      writeConfig({ decision: DECISION })
      const port = await start()

      await putConfig(port, { decision: { ...DECISION, apiKey: 'sk-rotated' } })
      expect((readConfig()['decision'] as Record<string, unknown>)['apiKey']).toBe('sk-rotated')
    })

    it('prunes a blank off block so it does not persist', async () => {
      writeConfig({ decision: DECISION })
      const port = await start()

      await putConfig(port, { decision: { mode: 'off', apiKey: '' } })
      expect(readConfig()['decision']).toBeUndefined()
      expect((await getConfig(port)).resolved.decisionConfigured).toBe(false)
    })
  })
})
