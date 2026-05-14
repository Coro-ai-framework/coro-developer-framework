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
  resolveTenantOverlaySource,
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
      saveLocalConfig({ git: { provider: 'github', username: 'u', token: 't' } }, configPath)
      const merged = mergeLocalConfig(
        { cloud: { url: 'https://cloud.example.com', token: 'new-tok' } },
        configPath,
      )
      expect(merged.git?.username).toBe('u')
      expect(merged.cloud?.url).toBe('https://cloud.example.com')
    })

    it('creates config if none exists', () => {
      const merged = mergeLocalConfig(
        { cloud: { url: 'https://c.com', token: 't' } },
        configPath,
      )
      expect(merged.cloud?.token).toBe('t')
    })
  })

  describe('detectMode', () => {
    it('returns hybrid when cloud config is present', () => {
      expect(detectMode(validConfig)).toBe('hybrid')
    })

    it('returns local when no cloud config', () => {
      expect(detectMode({})).toBe('local')
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

  // ── Intelligence schema flexibility ────────────────────────────────────
  //
  // Both `dir` and `gitRemote` are optional so the dashboard can save
  // either field on its own. Previously `dir` was required, which meant
  // typing a `gitRemote` while leaving the `dir` placeholder blank would
  // cause the entire intelligence block to be dropped at write time —
  // the field would silently disappear after a refresh. These tests pin
  // the round-trip behaviour so that regression cannot recur.
  describe('intelligence schema (round-trip without dir)', () => {
    it('accepts an intelligence block with only gitRemote', () => {
      const config: LocalConfig = {
        intelligence: { gitRemote: 'https://github.com/me/intel.git' },
      }
      saveLocalConfig(config, configPath)
      const loaded = loadLocalConfig(configPath)
      expect(loaded?.intelligence?.gitRemote).toBe('https://github.com/me/intel.git')
      expect(loaded?.intelligence?.dir).toBeUndefined()
    })

    it('accepts an intelligence block with only dir', () => {
      const config: LocalConfig = {
        intelligence: { dir: '/custom/intel' },
      }
      saveLocalConfig(config, configPath)
      const loaded = loadLocalConfig(configPath)
      expect(loaded?.intelligence?.dir).toBe('/custom/intel')
      expect(loaded?.intelligence?.gitRemote).toBeUndefined()
    })

    it('still uses the default dir when only gitRemote is set', () => {
      const config: LocalConfig = {
        intelligence: { gitRemote: 'https://github.com/me/intel.git' },
      }
      expect(resolveIntelligenceDir(config)).toContain('.coro')
    })
  })

  // ── Anthropic auth schema (REMOVED) ────────────────────────────────────
  //
  // The legacy top-level `anthropic` block was removed in Phase F of the
  // Anthropic-as-plugin migration. Anthropic credentials now live under
  // `plugins.installed.anthropic.config` and are validated by the plugin's
  // own `configSchema` (see `packages/llm-anthropic/src/executor.ts`).
  // The original schema-validation tests for `{ apiKey, oauthToken,
  // claudeLogin }` shapes have moved to the llm-anthropic test suite.

  // ── Proposals schema ─────────────────────────────────────────────────────
  describe('proposals config', () => {
    it('defaults to path-based routing when the block is missing', () => {
      saveLocalConfig({}, configPath)
      const loaded = loadLocalConfig(configPath)
      expect(resolveProposalsConfig(loaded).routing.strategy).toBe('path')
    })

    it('defaults to path-based routing when config is null', () => {
      expect(resolveProposalsConfig(null).routing.strategy).toBe('path')
    })

    it('round-trips an explicit agent-routing config', () => {
      saveLocalConfig(
        {
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
          proposals: { routing: { strategy: 'magic' } },
        }),
      )
      expect(() => loadLocalConfig(configPath)).toThrow()
    })
  })

  describe('resolveTenantOverlaySource', () => {
    it('defaults to none when overlay and gitRemote are absent', () => {
      expect(resolveTenantOverlaySource({})).toEqual({ kind: 'none' })
      expect(resolveTenantOverlaySource(null)).toEqual({ kind: 'none' })
    })

    it('uses intelligence.gitRemote when tenant.overlay is omitted', () => {
      expect(
        resolveTenantOverlaySource({
          intelligence: { gitRemote: 'https://github.com/org/intel.git' },
        }),
      ).toEqual({ kind: 'gitRemote', url: 'https://github.com/org/intel.git' })
    })

    it('trims intelligence.gitRemote', () => {
      expect(
        resolveTenantOverlaySource({
          intelligence: { gitRemote: '  https://github.com/org/x.git  ' },
        }),
      ).toEqual({ kind: 'gitRemote', url: 'https://github.com/org/x.git' })
    })

    it('honours explicit tenant.overlay over intelligence.gitRemote', () => {
      expect(
        resolveTenantOverlaySource({
          intelligence: { gitRemote: 'https://github.com/other.git' },
          tenant: {
            overlay: { kind: 'gitRemote', url: 'https://github.com/canonical/other.git', ref: 'main' },
          },
        }),
      ).toEqual({ kind: 'gitRemote', url: 'https://github.com/canonical/other.git', ref: 'main' })
    })

    it('honours explicit tenant.overlay.none and does not fall back to gitRemote', () => {
      expect(
        resolveTenantOverlaySource({
          intelligence: { gitRemote: 'https://github.com/org/intel.git' },
          tenant: { overlay: { kind: 'none' } },
        }),
      ).toEqual({ kind: 'none' })
    })
  })
})
