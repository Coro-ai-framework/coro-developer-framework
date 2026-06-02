import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildSettingsFromLocal } from '../../src/runner/build-settings'
import type { LocalConfig } from '../../src/config/local-config'

// ── buildSettingsFromLocal: plugin-installed → Settings mapping ──────────────
//
// These tests lock in the SCM single-source-of-truth contract. The
// Anthropic executor reads `settings.bitbucket.*` and `settings.github.*`
// to inject env vars into the Claude Code child process — if this mapping
// silently breaks, every job loses its git credentials.

const ENV_KEYS = [
  'BITBUCKET_WORKSPACE',
  'BITBUCKET_BASE_URL',
  'BITBUCKET_REVIEWER_USERNAME',
  'BITBUCKET_REVIEWER_APP_PASSWORD',
  'GITHUB_OWNER',
  'GITHUB_TOKEN',
  'GITHUB_API_BASE_URL',
] as const

describe('buildSettingsFromLocal', () => {
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

  beforeEach(() => {
    // Snapshot + clear every env var this builder reads so test order doesn't
    // matter and a real shell env doesn't leak in.
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  it('populates Settings.bitbucket from plugins.installed.bitbucket.config', () => {
    const config: LocalConfig = {
      plugins: {
        installed: {
          bitbucket: {
            enabled: true,
            config: {
              workspace: 'acme',
              coderUsername: 'coder@example.com',
              coderToken: 'ATATT-coder-token',
              reviewerUsername: 'reviewer@example.com',
              reviewerToken: 'ATATT-reviewer-token',
              baseUrl: 'https://api.bitbucket.example.com/2.0',
            },
          },
        },
      },
    }

    const settings = buildSettingsFromLocal(config)
    expect(settings.bitbucket.workspace).toBe('acme')
    expect(settings.bitbucket.baseUrl).toBe('https://api.bitbucket.example.com/2.0')
    expect(settings.bitbucket.coderAccount).toEqual({
      username: 'coder@example.com',
      appPassword: 'ATATT-coder-token',
    })
    expect(settings.bitbucket.reviewerAccount).toEqual({
      username: 'reviewer@example.com',
      appPassword: 'ATATT-reviewer-token',
    })
  })

  it('falls back reviewer account to coder when reviewer fields are absent', () => {
    const config: LocalConfig = {
      plugins: {
        installed: {
          bitbucket: {
            enabled: true,
            config: {
              workspace: 'acme',
              coderUsername: 'coder@example.com',
              coderToken: 'tok',
            },
          },
        },
      },
    }

    const settings = buildSettingsFromLocal(config)
    expect(settings.bitbucket.reviewerAccount.username).toBe('coder@example.com')
    expect(settings.bitbucket.reviewerAccount.appPassword).toBe('tok')
  })

  it('populates Settings.github from plugins.installed.github.config', () => {
    const config: LocalConfig = {
      plugins: {
        installed: {
          github: {
            enabled: true,
            config: {
              owner: 'acme-org',
              token: 'ghp_personal_access_token',
              baseUrl: 'https://github.example.com/api/v3',
            },
          },
        },
      },
    }

    const settings = buildSettingsFromLocal(config)
    expect(settings.github).toEqual({
      owner: 'acme-org',
      token: 'ghp_personal_access_token',
      baseUrl: 'https://github.example.com/api/v3',
    })
  })

  it('falls back to env vars when no plugin config is installed', () => {
    process.env.BITBUCKET_WORKSPACE = 'env-workspace'
    process.env.GITHUB_OWNER = 'env-owner'
    process.env.GITHUB_TOKEN = 'env-token'

    const settings = buildSettingsFromLocal({})
    expect(settings.bitbucket.workspace).toBe('env-workspace')
    expect(settings.github.owner).toBe('env-owner')
    expect(settings.github.token).toBe('env-token')
  })

  it('plugin config wins over env vars when both are present', () => {
    process.env.GITHUB_OWNER = 'env-owner'
    process.env.GITHUB_TOKEN = 'env-token'

    const config: LocalConfig = {
      plugins: {
        installed: {
          github: {
            enabled: true,
            config: { owner: 'plugin-owner', token: 'plugin-token' },
          },
        },
      },
    }

    const settings = buildSettingsFromLocal(config)
    expect(settings.github.owner).toBe('plugin-owner')
    expect(settings.github.token).toBe('plugin-token')
  })

  it('returns empty credentials when neither plugin config nor env vars are present', () => {
    const settings = buildSettingsFromLocal({})
    expect(settings.bitbucket.workspace).toBe('')
    expect(settings.bitbucket.coderAccount.username).toBe('')
    expect(settings.bitbucket.coderAccount.appPassword).toBe('')
    expect(settings.github.owner).toBe('')
    expect(settings.github.token).toBe('')
    // The base URLs default to the public endpoints — they are not
    // credentials, so absence is OK.
    expect(settings.bitbucket.baseUrl).toBe('https://api.bitbucket.org/2.0')
    expect(settings.github.baseUrl).toBe('https://api.github.com')
  })

  it('maps jobs.idleWatchdog from LocalConfig into Settings', () => {
    const config: LocalConfig = {
      jobs: {
        idleWatchdog: {
          idleThresholdMs: 120_000,
          maxNudges: 1,
          checkIntervalMs: 10_000,
        },
      },
    }
    const settings = buildSettingsFromLocal(config)
    expect(settings.jobs?.idleWatchdog).toEqual({
      idleThresholdMs: 120_000,
      maxNudges: 1,
      checkIntervalMs: 10_000,
    })
  })
})
