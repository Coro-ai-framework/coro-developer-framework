// Tests for the built-in `AnthropicExecutor` — manifest shape,
// capability surface, model catalogue, supports() predicate, and
// healthcheck variants. Does NOT exercise `executePhase()` (that
// throws by design in Phase 2; Phase 2c will wire it).

import { describe, it, expect } from 'vitest'
import pino from 'pino'
import {
  AnthropicExecutor,
  createAnthropicExecutor,
} from '../src/executor'
import type { AnthropicExecutorSettings as Settings, ClaudeAuthConfig } from '../src/types'

function makeSettings(): Settings {
  return {
    bitbucket: {
      workspace: '',
      coderAccount: { username: '', appPassword: '' },
    },
  }
}

function makeExecutor(auth: ClaudeAuthConfig) {
  return createAnthropicExecutor({
    settings: makeSettings(),
    auth,
    logger: silentLogger,
  })
}

const silentLogger = pino({ level: 'silent' })

describe('AnthropicExecutor — manifest', () => {
  it('declares id="anthropic" / kind="executor" / version=1.x', () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings(), auth: { method: 'claudeLogin' } as ClaudeAuthConfig,
      logger: silentLogger,
    })

    expect(ex.manifest.id).toBe('anthropic')
    expect(ex.manifest.kind).toBe('executor')
    expect(ex.kind).toBe('executor')
    expect(ex.manifest.version).toMatch(/^1\./)
    expect(ex.manifest.displayName).toContain('Anthropic')
  })

  it('exposes the Claude Agent SDK capability flag on the manifest', () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings(), auth: { method: 'claudeLogin' } as ClaudeAuthConfig,
      logger: silentLogger,
    })
    expect(ex.manifest.capabilities?.supportsClaudeAgentSdk).toBe(true)
  })
})

describe('AnthropicExecutor — capabilities', () => {
  it('reports the full Anthropic-native capability set', () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings(), auth: { method: 'claudeLogin' } as ClaudeAuthConfig,
      logger: silentLogger,
    })
    expect(ex.capabilities).toMatchObject({
      supportsNativeSubagents: true,
      supportsClaudeMdNativeWalkUp: true,
      supportsNativeFileTools: true,
      supportsSessionResume: true,
      supportsConversationReplay: false,
      supportsThinking: true,
      supportsImageInput: true,
      maxContextTokens: 1_000_000,
    })
  })
})

describe('AnthropicExecutor — listModels', () => {
  it('returns the curated catalogue (sonnet / opus / haiku)', () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings(), auth: { method: 'claudeLogin' } as ClaudeAuthConfig,
      logger: silentLogger,
    })
    const models = ex.listModels()

    expect(models).toHaveLength(5)
    const ids = models.map(m => m.id).sort()
    expect(ids).toEqual([
      'claude-haiku-4-5',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-sonnet-4-5',
      'claude-sonnet-4-6',
    ])

    // Tier mapping is part of the public contract — the dashboard's
    // model picker groups by tier.
    const byId = new Map(models.map(m => [m.id, m]))
    expect(byId.get('claude-sonnet-4-6')?.tier).toBe('coding')
    expect(byId.get('claude-opus-4-7')?.tier).toBe('planning')
    expect(byId.get('claude-haiku-4-5')?.tier).toBe('mini')
  })

  it('omits pricing fields (Anthropic reports total_cost_usd directly)', () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings(), auth: { method: 'claudeLogin' } as ClaudeAuthConfig,
      logger: silentLogger,
    })
    for (const m of ex.listModels()) {
      expect(m).not.toHaveProperty('inputPricePerMTokensUsd')
      expect(m).not.toHaveProperty('outputPricePerMTokensUsd')
    }
  })
})

describe('AnthropicExecutor — supports()', () => {
  const ex = createAnthropicExecutor({
    settings: makeSettings(), auth: { method: 'claudeLogin' } as ClaudeAuthConfig,
    logger: silentLogger,
  })

  it('accepts every catalogued model id', () => {
    expect(ex.supports('claude-sonnet-4-5')).toBe(true)
    expect(ex.supports('claude-opus-4-1')).toBe(true)
    expect(ex.supports('claude-haiku-4-5')).toBe(true)
  })

  it('accepts dated snapshot ids not in listModels (workflow YAML may pin)', () => {
    expect(ex.supports('claude-sonnet-4-5-20251022')).toBe(true)
  })

  it('rejects models from other providers', () => {
    expect(ex.supports('gpt-4o-mini')).toBe(false)
    expect(ex.supports('gemini-2.0-flash')).toBe(false)
    expect(ex.supports('llama-3.3')).toBe(false)
  })

  it('rejects empty / non-string-shaped inputs defensively', () => {
    expect(ex.supports('')).toBe(false)
    expect(ex.supports(null as unknown as string)).toBe(false)
    expect(ex.supports(undefined as unknown as string)).toBe(false)
  })
})

describe('AnthropicExecutor — healthcheck', () => {
  it('reports ok=true when auth.method=apiKey and apiKey is present', async () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings(), auth: { method: 'apiKey', apiKey: 'sk-test-1234' } as ClaudeAuthConfig,
      logger: silentLogger,
    })
    await ex.init({}, { logger: silentLogger, fetch: globalThis.fetch })
    await expect(ex.healthcheck()).resolves.toEqual({ ok: true })
  })

  it('reports ok=false when auth.method=apiKey but apiKey is missing', async () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings(), auth: { method: 'apiKey', apiKey: '' } as ClaudeAuthConfig,
      logger: silentLogger,
    })
    const h = await ex.healthcheck()
    expect(h.ok).toBe(false)
    expect(h.reason).toMatch(/apiKey/)
  })

  it('reports ok=true when auth.method=oauth and oauthToken is present', async () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings(), auth: { method: 'oauth', oauthToken: 'oauth-tok' } as ClaudeAuthConfig,
      logger: silentLogger,
    })
    await expect(ex.healthcheck()).resolves.toEqual({ ok: true })
  })

  it('reports ok=false when auth.method=oauth but oauthToken is missing', async () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings(), auth: { method: 'oauth', oauthToken: '' } as ClaudeAuthConfig,
      logger: silentLogger,
    })
    const h = await ex.healthcheck()
    expect(h.ok).toBe(false)
    expect(h.reason).toMatch(/oauthToken/)
  })

  it('reports ok=true for claudeLogin (defers to Claude Code persisted session)', async () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings(), auth: { method: 'claudeLogin' } as ClaudeAuthConfig,
      logger: silentLogger,
    })
    await expect(ex.healthcheck()).resolves.toEqual({ ok: true })
  })
})

// `executePhase` is wired up in Phase 2c. Its end-to-end behaviour
// (event mapping, signal propagation, session resume) is exercised by
// the runner integration tests in `tests/runner/runner.test.ts`,
// which drive a stub executor against the real `runJob` loop.

describe('AnthropicExecutor — mcpServer', () => {
  it('returns undefined (Anthropic consumes the runner-supplied Coro MCP server)', () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings(), auth: { method: 'claudeLogin' } as ClaudeAuthConfig,
      logger: silentLogger,
    })
    // Non-public protocol method; cast for the test.
    const mcp = (ex as unknown as { mcpServer(): unknown }).mcpServer()
    expect(mcp).toBeUndefined()
  })
})

describe('AnthropicExecutor — class identity', () => {
  it('factory returns an instance of AnthropicExecutor', () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings(), auth: { method: 'claudeLogin' } as ClaudeAuthConfig,
      logger: silentLogger,
    })
    expect(ex).toBeInstanceOf(AnthropicExecutor)
  })
})
