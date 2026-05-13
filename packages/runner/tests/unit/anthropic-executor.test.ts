// Tests for the built-in `AnthropicExecutor` — manifest shape,
// capability surface, model catalogue, supports() predicate, and
// healthcheck variants. Does NOT exercise `executePhase()` (that
// throws by design in Phase 2; Phase 2c will wire it).

import { describe, it, expect } from 'vitest'
import pino from 'pino'
import {
  AnthropicExecutor,
  createAnthropicExecutor,
} from '../../src/jobs/anthropic-executor'
import type { Settings } from '../../src/config/settings'

function makeSettings(auth: Settings['claude']['auth']): Settings {
  return {
    claude: {
      auth,
      planningModel: 'claude-opus-4-1',
      codingModel: 'claude-sonnet-4-5',
    },
  } as unknown as Settings
}

const silentLogger = pino({ level: 'silent' })

describe('AnthropicExecutor — manifest', () => {
  it('declares id="anthropic" / kind="executor" / version=1.x', () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings({ method: 'claudeLogin' } as never),
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
      settings: makeSettings({ method: 'claudeLogin' } as never),
      logger: silentLogger,
    })
    expect(ex.manifest.capabilities?.supportsClaudeAgentSdk).toBe(true)
  })
})

describe('AnthropicExecutor — capabilities', () => {
  it('reports the full Anthropic-native capability set', () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings({ method: 'claudeLogin' } as never),
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
      maxContextTokens: 200_000,
    })
  })
})

describe('AnthropicExecutor — listModels', () => {
  it('returns the curated catalogue (sonnet / opus / haiku)', () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings({ method: 'claudeLogin' } as never),
      logger: silentLogger,
    })
    const models = ex.listModels()

    expect(models).toHaveLength(3)
    const ids = models.map(m => m.id).sort()
    expect(ids).toEqual(['claude-haiku-4-5', 'claude-opus-4-1', 'claude-sonnet-4-5'])

    // Tier mapping is part of the public contract — the dashboard's
    // model picker groups by tier.
    const byId = new Map(models.map(m => [m.id, m]))
    expect(byId.get('claude-sonnet-4-5')?.tier).toBe('coding')
    expect(byId.get('claude-opus-4-1')?.tier).toBe('planning')
    expect(byId.get('claude-haiku-4-5')?.tier).toBe('mini')
  })

  it('omits pricing fields (Anthropic reports total_cost_usd directly)', () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings({ method: 'claudeLogin' } as never),
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
    settings: makeSettings({ method: 'claudeLogin' } as never),
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
      settings: makeSettings({ method: 'apiKey', apiKey: 'sk-test-1234' } as never),
      logger: silentLogger,
    })
    await ex.init({}, { logger: silentLogger, fetch: globalThis.fetch })
    await expect(ex.healthcheck()).resolves.toEqual({ ok: true })
  })

  it('reports ok=false when auth.method=apiKey but apiKey is missing', async () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings({ method: 'apiKey', apiKey: '' } as never),
      logger: silentLogger,
    })
    const h = await ex.healthcheck()
    expect(h.ok).toBe(false)
    expect(h.reason).toMatch(/apiKey/)
  })

  it('reports ok=true when auth.method=oauth and oauthToken is present', async () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings({ method: 'oauth', oauthToken: 'oauth-tok' } as never),
      logger: silentLogger,
    })
    await expect(ex.healthcheck()).resolves.toEqual({ ok: true })
  })

  it('reports ok=false when auth.method=oauth but oauthToken is missing', async () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings({ method: 'oauth', oauthToken: '' } as never),
      logger: silentLogger,
    })
    const h = await ex.healthcheck()
    expect(h.ok).toBe(false)
    expect(h.reason).toMatch(/oauthToken/)
  })

  it('reports ok=true for claudeLogin (defers to Claude Code persisted session)', async () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings({ method: 'claudeLogin' } as never),
      logger: silentLogger,
    })
    await expect(ex.healthcheck()).resolves.toEqual({ ok: true })
  })
})

describe('AnthropicExecutor — executePhase', () => {
  it('throws the Phase 2 stub error (will be wired in Phase 2c)', async () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings({ method: 'claudeLogin' } as never),
      logger: silentLogger,
    })

    // executePhase returns an async iterable that throws on first iteration.
    const iter = ex.executePhase({} as never)
    await expect((async () => {
      for await (const _ev of iter) { void _ev }
    })()).rejects.toThrow(/not yet wired into the runner/)
  })
})

describe('AnthropicExecutor — mcpServer', () => {
  it('returns undefined (Anthropic consumes the runner-supplied Coro MCP server)', () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings({ method: 'claudeLogin' } as never),
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
      settings: makeSettings({ method: 'claudeLogin' } as never),
      logger: silentLogger,
    })
    expect(ex).toBeInstanceOf(AnthropicExecutor)
  })
})
