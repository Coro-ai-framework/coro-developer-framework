// Tests for the centralized deprecation stage controller (P9).
// Verifies that `CORO_DEPRECATION_STAGE` flips behaviour at every
// affected surface — MCP wrappers, mapping tables, legacy config
// keys — without ripping changes through individual call sites.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  DeprecatedMcpToolError,
  getDeprecationStage,
  legacyConfigKeysBehaviour,
  legacyMappingTablesBehaviour,
  legacyMcpWrapperBehaviour,
  resetDeprecationStageCache,
} from '../../src/plugins/deprecation'

const originalStage = process.env['CORO_DEPRECATION_STAGE']

function setStage(value: string | undefined): void {
  if (value === undefined) {
    delete process.env['CORO_DEPRECATION_STAGE']
  } else {
    process.env['CORO_DEPRECATION_STAGE'] = value
  }
  resetDeprecationStageCache()
}

beforeEach(() => {
  resetDeprecationStageCache()
})

afterEach(() => {
  setStage(originalStage)
})

describe('getDeprecationStage', () => {
  it('defaults to "N" when the env var is unset', () => {
    setStage(undefined)
    expect(getDeprecationStage()).toBe('N')
  })

  it('reads "N+1" from the env var', () => {
    setStage('N+1')
    expect(getDeprecationStage()).toBe('N+1')
  })

  it('reads "N+2" from the env var', () => {
    setStage('N+2')
    expect(getDeprecationStage()).toBe('N+2')
  })

  it('falls back to "N" when the env var is garbage', () => {
    setStage('GARBAGE')
    expect(getDeprecationStage()).toBe('N')
  })

  it('caches the resolved stage across calls', () => {
    setStage('N+1')
    expect(getDeprecationStage()).toBe('N+1')
    // Mutating the env without resetting the cache keeps the original
    // value — call sites must call `resetDeprecationStageCache` to pick
    // up changes (tests do, production never needs to).
    process.env['CORO_DEPRECATION_STAGE'] = 'N'
    expect(getDeprecationStage()).toBe('N+1')
    resetDeprecationStageCache()
    expect(getDeprecationStage()).toBe('N')
  })
})

describe('legacyMcpWrapperBehaviour', () => {
  it('returns "warn" at stage N', () => {
    setStage('N')
    expect(legacyMcpWrapperBehaviour()).toBe('warn')
  })

  it('returns "error" at stage N+1', () => {
    setStage('N+1')
    expect(legacyMcpWrapperBehaviour()).toBe('error')
  })

  it('returns "remove" at stage N+2', () => {
    setStage('N+2')
    expect(legacyMcpWrapperBehaviour()).toBe('remove')
  })
})

describe('legacyMappingTablesBehaviour', () => {
  it('returns "dual-write" at stage N', () => {
    setStage('N')
    expect(legacyMappingTablesBehaviour()).toBe('dual-write')
  })

  it('returns "fallback-read" at stage N+1', () => {
    setStage('N+1')
    expect(legacyMappingTablesBehaviour()).toBe('fallback-read')
  })

  it('returns "gone" at stage N+2', () => {
    setStage('N+2')
    expect(legacyMappingTablesBehaviour()).toBe('gone')
  })
})

describe('legacyConfigKeysBehaviour', () => {
  it('returns "read" at stage N', () => {
    setStage('N')
    expect(legacyConfigKeysBehaviour()).toBe('read')
  })

  it('returns "silent" at stage N+1', () => {
    setStage('N+1')
    expect(legacyConfigKeysBehaviour()).toBe('silent')
  })

  it('returns "error" at stage N+2', () => {
    setStage('N+2')
    expect(legacyConfigKeysBehaviour()).toBe('error')
  })
})

describe('DeprecatedMcpToolError', () => {
  it('carries the old + new tool name on every instance', () => {
    const err = new DeprecatedMcpToolError('bb_create_pr', 'scm_create_pr')
    expect(err.toolName).toBe('bb_create_pr')
    expect(err.replacement).toBe('scm_create_pr')
    expect(err.message).toContain('bb_create_pr')
    expect(err.message).toContain('scm_create_pr')
    expect(err.name).toBe('DeprecatedMcpToolError')
  })

  it('is an Error subclass so existing handlers still catch it', () => {
    const err = new DeprecatedMcpToolError('jira_get_issue', 'tracker_get_issue')
    expect(err instanceof Error).toBe(true)
  })
})

// ── Integration: legacy config-key gate ──────────────────────────────────────

describe('resolvePluginsConfig + legacyConfigKeysBehaviour', () => {
  it('throws at N+2 when a legacy git block is present without plugins', async () => {
    setStage('N+2')
    const { resolvePluginsConfig } = await import('../../src/config/local-config')
    expect(() =>
      resolvePluginsConfig({
        anthropic: { method: 'apiKey', apiKey: 'k' },
        git: { provider: 'github', workspace: 'me', username: 'u', token: 't' },
      }),
    ).toThrow(/no longer supported/i)
  })

  it('translates silently at N+1', async () => {
    setStage('N+1')
    const { resolvePluginsConfig } = await import('../../src/config/local-config')
    const got = resolvePluginsConfig({
      anthropic: { method: 'apiKey', apiKey: 'k' },
      git: { provider: 'github', workspace: 'me', username: 'u', token: 't' },
    })
    expect(got.installed['github']).toBeDefined()
  })

  it('translates at N (default)', async () => {
    setStage('N')
    const { resolvePluginsConfig } = await import('../../src/config/local-config')
    const got = resolvePluginsConfig({
      anthropic: { method: 'apiKey', apiKey: 'k' },
      git: { provider: 'github', workspace: 'me', username: 'u', token: 't' },
    })
    expect(got.installed['github']).toBeDefined()
  })

  it('always honours an explicit plugins block regardless of stage', async () => {
    setStage('N+2')
    const { resolvePluginsConfig } = await import('../../src/config/local-config')
    const got = resolvePluginsConfig({
      anthropic: { method: 'apiKey', apiKey: 'k' },
      plugins: { installed: { 'github': { enabled: true, config: { owner: 'me', token: 't' } } } },
    })
    expect(got.installed['github']).toBeDefined()
  })
})
