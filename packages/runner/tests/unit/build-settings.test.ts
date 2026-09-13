import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import { buildSettingsFromLocal, seedExecutorDefaultAliases } from '../../src/runner/build-settings'
import type { LocalConfig } from '../../src/config/local-config'
import { PluginRegistry } from '../../src/plugins/registry'
import type {
  ExecutorCapabilities,
  PhaseExecutionRequest,
  PhaseExecutorEvent,
  PhaseExecutorRuntime,
} from '../../src/plugins/types'
import type { PluginManifest } from '@coro-ai/plugin-sdk'
import type { Settings } from '../../src/config/settings'

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

  it('does not hardcode llm.defaultProvider when config omits it', () => {
    const settings = buildSettingsFromLocal({})
    expect(settings.llm?.defaultProvider).toBeUndefined()
  })
})

const ZERO_CAPS: ExecutorCapabilities = {
  supportsNativeSubagents: false,
  supportsClaudeMdNativeWalkUp: false,
  supportsNativeFileTools: false,
  supportsSessionResume: false,
  supportsConversationReplay: false,
  supportsThinking: false,
  supportsImageInput: false,
  maxContextTokens: 100_000,
}

function fakeExecutor(opts: {
  id: string
  healthy: boolean
  prefix: string
  aliases: Record<string, { provider: string; model: string }>
}): PhaseExecutorRuntime {
  const manifest: PluginManifest = {
    id: opts.id,
    kind: 'executor',
    version: '1.0.0',
    displayName: opts.id,
    hostCompatibility: '*',
    configSchema: z.object({}).passthrough(),
  }
  return {
    manifest,
    kind: 'executor' as const,
    capabilities: ZERO_CAPS,
    listModels: () => [],
    supports: (model: string) => model.startsWith(opts.prefix),
    defaultAliases: () => opts.aliases,
    executePhase: async function* (_req: PhaseExecutionRequest): AsyncIterable<PhaseExecutorEvent> {
      void _req
    },
    async init() { /* no-op */ },
    async healthcheck() { return { ok: opts.healthy } },
    async dispose() { /* no-op */ },
  }
}

const LLM_ENV_KEYS = [
  'CORO_PLANNING_MODEL',
  'CORO_CODING_MODEL',
  'CORO_DEFAULT_PROVIDER',
  'CLAUDE_PLANNING_MODEL',
  'CLAUDE_CODING_MODEL',
] as const

describe('seedExecutorDefaultAliases', () => {
  const savedEnv: Partial<Record<(typeof LLM_ENV_KEYS)[number], string | undefined>> = {}

  beforeEach(() => {
    for (const k of LLM_ENV_KEYS) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of LLM_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  it('seeds tier aliases from the sole healthy executor, not the first registered', async () => {
    const registry = new PluginRegistry()
    registry.register(fakeExecutor({
      id: 'anthropic',
      healthy: false,
      prefix: 'claude-',
      aliases: {
        'tier:planning': { provider: 'anthropic', model: 'claude-opus-5' },
        'tier:coding': { provider: 'anthropic', model: 'claude-sonnet-5' },
        planning: { provider: 'anthropic', model: 'claude-opus-5' },
        coding: { provider: 'anthropic', model: 'claude-sonnet-5' },
      },
    }))
    registry.register(fakeExecutor({
      id: 'openai',
      healthy: true,
      prefix: 'gpt-',
      aliases: {
        'tier:planning': { provider: 'openai', model: 'gpt-5.6-sol' },
        'tier:coding': { provider: 'openai', model: 'gpt-5.6-terra' },
        planning: { provider: 'openai', model: 'gpt-5.6-sol' },
        coding: { provider: 'openai', model: 'gpt-5.6-terra' },
        openaiPlanning: { provider: 'openai', model: 'gpt-5.6-sol' },
      },
    }))
    const settings = { llm: { aliases: {} } } as Settings
    await seedExecutorDefaultAliases({ plugins: registry, settings })
    expect(settings.llm?.defaultProvider).toBe('openai')
    expect(settings.llm?.aliases?.['tier:planning']).toEqual({ provider: 'openai', model: 'gpt-5.6-sol' })
    expect(settings.llm?.aliases?.['tier:coding']).toEqual({ provider: 'openai', model: 'gpt-5.6-terra' })
    expect(settings.llm?.aliases?.planning).toEqual({ provider: 'openai', model: 'gpt-5.6-sol' })
    expect(settings.llm?.aliases?.openaiPlanning).toEqual({ provider: 'openai', model: 'gpt-5.6-sol' })
  })

  it('keeps operator-saved tier aliases over plugin defaults', async () => {
    const registry = new PluginRegistry()
    registry.register(fakeExecutor({
      id: 'openai',
      healthy: true,
      prefix: 'gpt-',
      aliases: { 'tier:coding': { provider: 'openai', model: 'gpt-5.6-terra' } },
    }))
    const settings = {
      llm: {
        defaultProvider: 'openai',
        aliases: { 'tier:coding': { provider: 'openai', model: 'gpt-5.4' } },
      },
    } as Settings
    await seedExecutorDefaultAliases({ plugins: registry, settings })
    expect(settings.llm?.aliases?.['tier:coding']).toEqual({ provider: 'openai', model: 'gpt-5.4' })
  })

  it('resolves CORO_PLANNING_MODEL via supports() instead of a hardcoded provider', async () => {
    const registry = new PluginRegistry()
    registry.register(fakeExecutor({
      id: 'openai',
      healthy: true,
      prefix: 'gpt-',
      aliases: { 'tier:planning': { provider: 'openai', model: 'gpt-5.6-sol' } },
    }))
    process.env.CORO_PLANNING_MODEL = 'gpt-5.4'
    const settings = { llm: { aliases: {} } } as Settings
    await seedExecutorDefaultAliases({ plugins: registry, settings })
    expect(settings.llm?.aliases?.['tier:planning']).toEqual({ provider: 'openai', model: 'gpt-5.4' })
    expect(settings.llm?.aliases?.planning).toEqual({ provider: 'openai', model: 'gpt-5.4' })
  })
})

