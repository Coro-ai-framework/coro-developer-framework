import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyFreshInstallPluginDefaults,
  loadLocalConfig,
  persistFreshInstallDefaultsIfNeeded,
  saveLocalConfig,
} from '../../src/config/local-config'
import { applyFreshInstallScmDefaults } from '../../src/config/plugins-config'

describe('applyFreshInstallScmDefaults', () => {
  it('enables local and sets default scm when nothing else is configured', () => {
    expect(applyFreshInstallScmDefaults(undefined)).toEqual({
      defaults: { scm: 'local' },
      installed: { local: { enabled: true, config: {} } },
    })
  })

  it('leaves an enabled GitHub install untouched', () => {
    const input = {
      installed: {
        github: { enabled: true, config: { owner: 'acme', token: 'ghp_test' } },
      },
    }
    expect(applyFreshInstallScmDefaults(input)).toEqual(input)
  })

  it('adds local when GitHub is explicitly disabled', () => {
    expect(
      applyFreshInstallScmDefaults({
        installed: { github: { enabled: false, config: {} } },
      }),
    ).toEqual({
      defaults: { scm: 'local' },
      installed: {
        github: { enabled: false, config: {} },
        local: { enabled: true, config: {} },
      },
    })
  })
})

describe('persistFreshInstallDefaultsIfNeeded', () => {
  it('writes local SCM defaults to disk on first boot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-fresh-'))
    const configPath = path.join(dir, 'config.json')

    const next = persistFreshInstallDefaultsIfNeeded(null, configPath)

    expect(next.plugins?.installed?.local).toEqual({ enabled: true, config: {} })
    expect(next.plugins?.defaults?.scm).toBe('local')
    expect(loadLocalConfig(configPath)).toEqual(next)
  })

  it('does not overwrite config after FTUE is marked complete', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-fresh-'))
    const configPath = path.join(dir, 'config.json')
    saveLocalConfig({ setup: { completedAt: '2026-01-01T00:00:00.000Z' } }, configPath)

    persistFreshInstallDefaultsIfNeeded(loadLocalConfig(configPath), configPath)

    expect(loadLocalConfig(configPath)).toEqual({
      setup: { completedAt: '2026-01-01T00:00:00.000Z' },
    })
  })
})

describe('applyFreshInstallPluginDefaults', () => {
  it('merges local SCM into an anthropic-only config', () => {
    expect(
      applyFreshInstallPluginDefaults({
        plugins: {
          installed: {
            anthropic: { enabled: true, config: { method: 'claudeLogin' } },
          },
        },
      }),
    ).toEqual({
      plugins: {
        defaults: { scm: 'local' },
        installed: {
          anthropic: { enabled: true, config: { method: 'claudeLogin' } },
          local: { enabled: true, config: {} },
        },
      },
    })
  })
})
