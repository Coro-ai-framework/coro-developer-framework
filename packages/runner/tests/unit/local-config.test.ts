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
  resolveProposalsConfig,
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

    it('returns local when config is null', () => {
      // Env vars (REDIS_URL etc.) are intentionally ignored — there is no
      // longer a legacy Redis-monolith fallback.
      expect(detectMode(null)).toBe('local')
    })
  })

  describe('resolveIntelligenceDir', () => {
    it('uses config value', () => {
      expect(resolveIntelligenceDir(validConfig)).toBe('/tmp/intel')
    })

    it('expands tilde', () => {
      const config: LocalConfig = {
        anthropic: { method: 'apiKey', apiKey: 'k' },
        intelligence: { dir: '~/.coro/intel' },
      }
      expect(resolveIntelligenceDir(config)).toBe(path.join(os.homedir(), '.coro/intel'))
    })

    it('falls back to default', () => {
      expect(resolveIntelligenceDir(null)).toContain('.coro')
    })
  })

  describe('resolveWorkingDir', () => {
    it('uses config value', () => {
      expect(resolveWorkingDir(validConfig)).toBe('/tmp/work')
    })

    it('falls back to default', () => {
      expect(resolveWorkingDir(null)).toContain('.coro')
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

    it('accepts { method: "claudeLogin" } with optional account metadata', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          anthropic: {
            method: 'claudeLogin',
            account: {
              email: 'dev@a5labs.com',
              organization: 'A5 Labs',
              subscriptionType: 'max',
              tokenSource: 'oauth',
              apiProvider: 'firstParty',
            },
          },
        }),
      )
      const loaded = loadLocalConfig(configPath)
      expect(loaded?.anthropic.method).toBe('claudeLogin')
      expect(loaded?.anthropic.account?.email).toBe('dev@a5labs.com')
      expect(loaded?.anthropic.account?.apiProvider).toBe('firstParty')
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

  // ── Proposals schema ─────────────────────────────────────────────────────
  describe('proposals config', () => {
    it('defaults to path-based routing when the block is missing', () => {
      saveLocalConfig({ anthropic: { method: 'apiKey', apiKey: 'sk-1' } }, configPath)
      const loaded = loadLocalConfig(configPath)
      expect(resolveProposalsConfig(loaded).routing.strategy).toBe('path')
    })

    it('defaults to path-based routing when config is null', () => {
      expect(resolveProposalsConfig(null).routing.strategy).toBe('path')
    })

    it('round-trips an explicit agent-routing config', () => {
      saveLocalConfig(
        {
          anthropic: { method: 'apiKey', apiKey: 'sk-1' },
          proposals: { routing: { strategy: 'agent' } },
        },
        configPath,
      )
      const loaded = loadLocalConfig(configPath)
      expect(resolveProposalsConfig(loaded).routing.strategy).toBe('agent')
    })

    it('rejects an unknown routing strategy', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          anthropic: { method: 'apiKey', apiKey: 'sk-1' },
          proposals: { routing: { strategy: 'magic' } },
        }),
      )
      expect(() => loadLocalConfig(configPath)).toThrow()
    })
  })
})
