import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  loadLocalConfig,
  saveLocalConfig,
  mergeLocalConfig,
  detectMode,
  resolveIntelligenceDir,
  resolveWorkingDir,
  type LocalConfig,
} from '../../src/config/local-config'

describe('local-config', () => {
  let tmpDir: string
  let configPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a5-test-'))
    configPath = path.join(tmpDir, 'config.json')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const validConfig: LocalConfig = {
    anthropic: { method: 'apiKey', apiKey: 'sk-test-123' },
    cloud: { url: 'https://cloud.a5labs.com', token: 'tok-abc' },
    intelligence: { dir: '/tmp/intel', gitRemote: 'https://example.com/repo.git' },
    paths: { workingDir: '/tmp/work' },
    git: { provider: 'bitbucket', workspace: 'a5labs', username: 'user', token: 'git-tok' },
  }

  describe('saveLocalConfig + loadLocalConfig', () => {
    it('round-trips a full config', () => {
      saveLocalConfig(validConfig, configPath)
      const loaded = loadLocalConfig(configPath)
      expect(loaded).toEqual(validConfig)
    })

    it('returns null for missing file', () => {
      expect(loadLocalConfig(configPath)).toBeNull()
    })

    it('creates parent directories', () => {
      const nested = path.join(tmpDir, 'sub', 'dir', 'config.json')
      saveLocalConfig(validConfig, nested)
      expect(loadLocalConfig(nested)).toEqual(validConfig)
    })

    it('sets restrictive file permissions', () => {
      saveLocalConfig(validConfig, configPath)
      const stat = fs.statSync(configPath)
      // 0o600 = owner read/write only
      expect(stat.mode & 0o777).toBe(0o600)
    })
  })

  describe('mergeLocalConfig', () => {
    it('merges cloud into existing config', () => {
      saveLocalConfig({ anthropic: { method: 'apiKey', apiKey: 'sk-old' } }, configPath)
      const merged = mergeLocalConfig(
        { cloud: { url: 'https://cloud.example.com', token: 'new-tok' } },
        configPath,
      )
      expect(merged.anthropic.apiKey).toBe('sk-old')
      expect(merged.cloud?.url).toBe('https://cloud.example.com')
    })

    it('creates config if none exists', () => {
      const merged = mergeLocalConfig(
        { anthropic: { method: 'apiKey', apiKey: 'sk-new' }, cloud: { url: 'https://c.com', token: 't' } },
        configPath,
      )
      expect(merged.anthropic.apiKey).toBe('sk-new')
      expect(merged.cloud?.token).toBe('t')
    })
  })

  describe('detectMode', () => {
    it('returns hybrid when cloud config is present', () => {
      expect(detectMode(validConfig)).toBe('hybrid')
    })

    it('returns local when no cloud config', () => {
      expect(detectMode({ anthropic: { method: 'apiKey', apiKey: 'sk-test' } })).toBe('local')
    })

    it('returns local when config is null and no env vars', () => {
      const origRedis = process.env.REDIS_URL
      const origSettings = process.env.SETTINGS_PATH
      delete process.env.REDIS_URL
      delete process.env.SETTINGS_PATH
      try {
        expect(detectMode(null)).toBe('local')
      } finally {
        if (origRedis !== undefined) process.env.REDIS_URL = origRedis
        if (origSettings !== undefined) process.env.SETTINGS_PATH = origSettings
      }
    })

    it('returns legacy when config is null but REDIS_URL is set', () => {
      const orig = process.env.REDIS_URL
      process.env.REDIS_URL = 'redis://localhost:6379'
      try {
        expect(detectMode(null)).toBe('legacy')
      } finally {
        if (orig !== undefined) process.env.REDIS_URL = orig
        else delete process.env.REDIS_URL
      }
    })
  })

  describe('resolveIntelligenceDir', () => {
    it('uses config value', () => {
      expect(resolveIntelligenceDir(validConfig)).toBe('/tmp/intel')
    })

    it('expands tilde', () => {
      const config: LocalConfig = {
        anthropic: { method: 'apiKey', apiKey: 'k' },
        intelligence: { dir: '~/.a5/intel' },
      }
      expect(resolveIntelligenceDir(config)).toBe(path.join(os.homedir(), '.a5/intel'))
    })

    it('falls back to default', () => {
      expect(resolveIntelligenceDir(null)).toContain('.a5')
    })
  })

  describe('resolveWorkingDir', () => {
    it('uses config value', () => {
      expect(resolveWorkingDir(validConfig)).toBe('/tmp/work')
    })

    it('falls back to default', () => {
      expect(resolveWorkingDir(null)).toContain('.a5')
    })
  })

  // ── Anthropic auth schema ──────────────────────────────────────────────
  //
  // The schema must accept (a) legacy `{ apiKey }` configs written by older
  // versions and (b) the new discriminated shape, but reject any variant
  // missing the credential for the chosen method.
  describe('anthropic auth schema', () => {
    it('accepts legacy { apiKey } config (method defaults to apiKey)', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ anthropic: { apiKey: 'sk-legacy-123' } }),
      )
      const loaded = loadLocalConfig(configPath)
      expect(loaded?.anthropic.method).toBe('apiKey')
      expect(loaded?.anthropic.apiKey).toBe('sk-legacy-123')
    })

    it('accepts { method: "oauth", oauthToken }', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ anthropic: { method: 'oauth', oauthToken: 'sk-ant-oat01-abc' } }),
      )
      const loaded = loadLocalConfig(configPath)
      expect(loaded?.anthropic.method).toBe('oauth')
      expect(loaded?.anthropic.oauthToken).toBe('sk-ant-oat01-abc')
    })

    it('rejects { method: "oauth" } without a token', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ anthropic: { method: 'oauth' } }),
      )
      expect(() => loadLocalConfig(configPath)).toThrow()
    })

    it('rejects { method: "apiKey" } without a key', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ anthropic: { method: 'apiKey' } }),
      )
      expect(() => loadLocalConfig(configPath)).toThrow()
    })

    it('rejects legacy { apiKey: "" } (empty string is not a credential)', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ anthropic: { apiKey: '' } }),
      )
      expect(() => loadLocalConfig(configPath)).toThrow()
    })
  })
})
