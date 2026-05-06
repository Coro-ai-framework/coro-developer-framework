// Tests for the v1.5 drop-in plugin loader. Covers manifest validation,
// host-compat semver subset, factory invocation, and the shape-check
// guard that stops a malformed factory from poisoning the registry.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pino from 'pino'
import {
  HOST_PLUGIN_API_VERSION,
  isCompatibleHostVersion,
  loadDropinPlugins,
  loadOne,
  buildDropinFactoryMap,
} from '../../src/plugins/loader'
import type { PluginManifest, PluginRuntime } from '../../src/plugins/types'

const logger = pino({ level: 'silent' })

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-plugin-loader-'))
  return dir
}

function writeManifest(dir: string, body: unknown): void {
  fs.writeFileSync(path.join(dir, 'coro-plugin.json'), JSON.stringify(body, null, 2))
}

function writeIndex(dir: string, source: string, ext: 'mjs' | 'cjs' | 'js' = 'mjs'): void {
  fs.writeFileSync(path.join(dir, `index.${ext}`), source)
}

describe('isCompatibleHostVersion', () => {
  it('accepts "*" and empty', () => {
    expect(isCompatibleHostVersion('*', '1.0.0')).toBe(true)
    expect(isCompatibleHostVersion('', '1.0.0')).toBe(true)
  })

  it('strict equals matches only the exact version', () => {
    expect(isCompatibleHostVersion('1.0.0', '1.0.0')).toBe(true)
    expect(isCompatibleHostVersion('1.0.0', '1.0.1')).toBe(false)
    expect(isCompatibleHostVersion('1.0.0', '2.0.0')).toBe(false)
  })

  it('caret matches same major', () => {
    expect(isCompatibleHostVersion('^1.0.0', '1.5.3')).toBe(true)
    expect(isCompatibleHostVersion('^1.0.0', '1.0.0')).toBe(true)
    expect(isCompatibleHostVersion('^1.0.0', '2.0.0')).toBe(false)
    expect(isCompatibleHostVersion('^1.2.0', '1.1.9')).toBe(false) // need ≥1.2.0
  })

  it('tilde matches same minor', () => {
    expect(isCompatibleHostVersion('~1.2.0', '1.2.5')).toBe(true)
    expect(isCompatibleHostVersion('~1.2.0', '1.3.0')).toBe(false)
    expect(isCompatibleHostVersion('~1.2.0', '1.2.0')).toBe(true)
    expect(isCompatibleHostVersion('~1.2.5', '1.2.4')).toBe(false)
  })

  it('returns false for malformed versions', () => {
    expect(isCompatibleHostVersion('^1.0.0', 'banana')).toBe(false)
    expect(isCompatibleHostVersion('^banana', '1.0.0')).toBe(false)
  })
})

describe('loadOne', () => {
  let dir: string

  beforeEach(() => {
    dir = tempDir()
  })

  afterEach(() => {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when there is no coro-plugin.json (not a plugin folder)', async () => {
    expect(await loadOne({ pluginDir: dir, logger })).toBeNull()
  })

  it('throws when the manifest fails schema validation', async () => {
    writeManifest(dir, { id: 'broken' /* missing kind, version, displayName, hostCompatibility */ })
    await expect(loadOne({ pluginDir: dir, logger })).rejects.toThrow()
  })

  it('throws when hostCompatibility does not satisfy the runner', async () => {
    writeManifest(dir, {
      id: 'too-new',
      kind: 'scm',
      version: '1.0.0',
      displayName: 'Too New',
      hostCompatibility: '^99.0.0',
    })
    writeIndex(dir, 'export default () => ({ manifest: {}, init: async () => {}, healthcheck: async () => ({ ok: true }), dispose: async () => {} })')
    await expect(loadOne({ pluginDir: dir, logger })).rejects.toThrow(/hostCompatibility/i)
  })

  it('throws when no entry file is present', async () => {
    writeManifest(dir, {
      id: 'no-entry',
      kind: 'scm',
      version: '1.0.0',
      displayName: 'No Entry',
      hostCompatibility: HOST_PLUGIN_API_VERSION,
    })
    await expect(loadOne({ pluginDir: dir, logger })).rejects.toThrow(/index/i)
  })

  it('loads a valid plugin and returns a working factory', async () => {
    writeManifest(dir, {
      id: 'my-test-scm',
      kind: 'scm',
      version: '1.0.0',
      displayName: 'My Test SCM',
      hostCompatibility: '^1.0.0',
    })
    const fakeManifest: PluginManifest = {
      id: 'my-test-scm',
      kind: 'scm',
      version: '1.0.0',
      displayName: 'My Test SCM',
      hostCompatibility: '^1.0.0',
      // Include a minimum-shape configSchema; we don't import zod in
      // the test fixture so we synthesise the parse/safeParse stubs.
      configSchema: {
        parse: (x: unknown) => x,
        safeParse: (x: unknown) => ({ success: true, data: x }),
      } as never,
    }
    writeIndex(dir, `
      export default () => ({
        manifest: ${JSON.stringify(fakeManifest)},
        kind: 'scm',
        init: async () => {},
        healthcheck: async () => ({ ok: true }),
        dispose: async () => {},
      })
    `)
    const got = await loadOne({ pluginDir: dir, logger })
    expect(got).not.toBeNull()
    expect(got!.id).toBe('my-test-scm')
    const runtime = await got!.factory({ config: {}, logger }) as PluginRuntime
    expect(runtime.manifest.id).toBe('my-test-scm')
    expect(typeof runtime.init).toBe('function')
    expect(typeof runtime.dispose).toBe('function')
  })

  it('rejects a factory that returns the wrong shape', async () => {
    writeManifest(dir, {
      id: 'bad-shape',
      kind: 'scm',
      version: '1.0.0',
      displayName: 'Bad Shape',
      hostCompatibility: '^1.0.0',
    })
    writeIndex(dir, 'export default () => ({ /* missing init/healthcheck/dispose */ })')
    const got = await loadOne({ pluginDir: dir, logger })
    expect(got).not.toBeNull()
    await expect(got!.factory({ config: {}, logger })).rejects.toThrow(/PluginRuntime|missing/i)
  })

  it('rejects a factory that does not default-export a function', async () => {
    writeManifest(dir, {
      id: 'no-default',
      kind: 'scm',
      version: '1.0.0',
      displayName: 'No Default',
      hostCompatibility: '^1.0.0',
    })
    writeIndex(dir, 'export const notDefault = 42')
    const got = await loadOne({ pluginDir: dir, logger })
    expect(got).not.toBeNull()
    await expect(got!.factory({ config: {}, logger })).rejects.toThrow(/default-export/i)
  })
})

describe('loadDropinPlugins', () => {
  let root: string

  beforeEach(() => {
    root = tempDir()
  })

  afterEach(() => {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
  })

  it('returns [] when the plugins root does not exist', async () => {
    const got = await loadDropinPlugins({
      pluginsRoot: path.join(root, 'does-not-exist'),
      logger,
    })
    expect(got).toEqual([])
  })

  it('returns [] when the root is empty', async () => {
    const got = await loadDropinPlugins({ pluginsRoot: root, logger })
    expect(got).toEqual([])
  })

  it('skips dotfiles and non-directories', async () => {
    fs.writeFileSync(path.join(root, '.DS_Store'), '')
    fs.writeFileSync(path.join(root, 'README.md'), '')
    fs.mkdirSync(path.join(root, '.hidden'))
    const got = await loadDropinPlugins({ pluginsRoot: root, logger })
    expect(got).toEqual([])
  })

  it('loads multiple plugins and isolates failures', async () => {
    // Plugin A — valid
    const a = path.join(root, 'plugin-a')
    fs.mkdirSync(a)
    writeManifest(a, {
      id: 'plugin-a',
      kind: 'scm',
      version: '1.0.0',
      displayName: 'A',
      hostCompatibility: '^1.0.0',
    })
    writeIndex(a, 'export default () => ({ manifest: { id: "plugin-a" }, init: async () => {}, healthcheck: async () => ({ ok: true }), dispose: async () => {} })')

    // Plugin B — manifest is malformed (loadOne throws → loader logs & skips)
    const b = path.join(root, 'plugin-b')
    fs.mkdirSync(b)
    writeManifest(b, { id: 'plugin-b' })   // missing required fields

    // Plugin C — host-incompat (loadOne throws → loader logs & skips)
    const c = path.join(root, 'plugin-c')
    fs.mkdirSync(c)
    writeManifest(c, {
      id: 'plugin-c',
      kind: 'scm',
      version: '1.0.0',
      displayName: 'C',
      hostCompatibility: '^99.0.0',
    })
    writeIndex(c, 'export default () => ({})')

    const got = await loadDropinPlugins({ pluginsRoot: root, logger })
    expect(got.map(g => g.id)).toEqual(['plugin-a'])
  })

  it('honours onlyIds to filter the scanned set', async () => {
    const a = path.join(root, 'plugin-a')
    const b = path.join(root, 'plugin-b')
    fs.mkdirSync(a)
    fs.mkdirSync(b)
    writeManifest(a, {
      id: 'plugin-a',
      kind: 'scm',
      version: '1.0.0',
      displayName: 'A',
      hostCompatibility: '^1.0.0',
    })
    writeIndex(a, 'export default () => ({ manifest: { id: "plugin-a" }, init: async () => {}, healthcheck: async () => ({ ok: true }), dispose: async () => {} })')
    writeManifest(b, {
      id: 'plugin-b',
      kind: 'scm',
      version: '1.0.0',
      displayName: 'B',
      hostCompatibility: '^1.0.0',
    })
    writeIndex(b, 'export default () => ({ manifest: { id: "plugin-b" }, init: async () => {}, healthcheck: async () => ({ ok: true }), dispose: async () => {} })')

    const got = await loadDropinPlugins({ pluginsRoot: root, logger, onlyIds: ['plugin-a'] })
    expect(got.map(g => g.id)).toEqual(['plugin-a'])
  })
})

describe('buildDropinFactoryMap', () => {
  let root: string

  beforeEach(() => {
    root = tempDir()
  })

  afterEach(() => {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
  })

  it('keys factories by manifest id and respects PluginsConfig.installed', async () => {
    const a = path.join(root, 'plugin-a')
    fs.mkdirSync(a)
    writeManifest(a, {
      id: 'plugin-a',
      kind: 'scm',
      version: '1.0.0',
      displayName: 'A',
      hostCompatibility: '^1.0.0',
    })
    writeIndex(a, 'export default () => ({ manifest: { id: "plugin-a" }, init: async () => {}, healthcheck: async () => ({ ok: true }), dispose: async () => {} })')

    const map = await buildDropinFactoryMap({
      pluginsRoot: root,
      logger,
      pluginsConfig: {
        installed: { 'plugin-a': { enabled: true, config: {} } },
      },
    })
    expect(Object.keys(map)).toEqual(['plugin-a'])
  })

  it('omits a plugin whose installed.enabled is false', async () => {
    const a = path.join(root, 'plugin-a')
    fs.mkdirSync(a)
    writeManifest(a, {
      id: 'plugin-a',
      kind: 'scm',
      version: '1.0.0',
      displayName: 'A',
      hostCompatibility: '^1.0.0',
    })
    writeIndex(a, 'export default () => ({ manifest: { id: "plugin-a" }, init: async () => {}, healthcheck: async () => ({ ok: true }), dispose: async () => {} })')

    const map = await buildDropinFactoryMap({
      pluginsRoot: root,
      logger,
      pluginsConfig: {
        installed: { 'plugin-a': { enabled: false, config: {} } },
      },
    })
    expect(map).toEqual({})
  })
})
