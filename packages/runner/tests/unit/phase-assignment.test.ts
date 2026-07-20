// Tests for `resolvePhaseAssignment()` — the pure function that translates
// a workflow phase's `model:` / `provider:` fields into a concrete
// `{ runtime, model, modelHints }` triple by consulting the alias map
// and the plugin registry.

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { PluginRegistry } from '../../src/plugins'
import { resolvePhaseAssignment, resolveModelAlias } from '../../src/jobs/phase-assignment'
import type { Settings } from '../../src/config/settings'
import type {
  ExecutorCapabilities,
  PhaseExecutionRequest,
  PhaseExecutorEvent,
  PhaseExecutorRuntime,
} from '../../src/plugins/types'
import type { PluginManifest } from '@coro-ai/plugin-sdk'

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

function makeFakeExecutor(id: string, prefix: string): PhaseExecutorRuntime {
  const manifest: PluginManifest = {
    id,
    kind: 'executor',
    version: '1.0.0',
    displayName: id,
    hostCompatibility: '*',
    configSchema: z.object({}).passthrough(),
  }
  return {
    manifest,
    kind: 'executor' as const,
    capabilities: ZERO_CAPS,
    listModels: () => [],
    supports: (m: string) => m.startsWith(prefix),
    // eslint-disable-next-line @typescript-eslint/require-await
    executePhase: async function* (_req: PhaseExecutionRequest): AsyncIterable<PhaseExecutorEvent> {
      void _req
    },
    async init() { /* no-op */ },
    async healthcheck() { return { ok: true } },
    async dispose() { /* no-op */ },
  }
}

function buildRegistry(): PluginRegistry {
  const reg = new PluginRegistry()
  reg.register(makeFakeExecutor('anthropic', 'claude-'))
  reg.register(makeFakeExecutor('openai', 'gpt-'))
  return reg
}

function makeSettings(overrides: Partial<NonNullable<Settings['llm']>>): Settings {
  return {
    llm: {
      defaultProvider: 'anthropic',
      providers: {},
      aliases: {},
      ...overrides,
    },
  } as unknown as Settings
}

describe('resolvePhaseAssignment', () => {
  it('resolves an alias key to the alias provider + model', () => {
    const reg = buildRegistry()
    const settings = makeSettings({
      aliases: { planning: { provider: 'anthropic', model: 'claude-opus-4-1' } },
    })

    const r = resolvePhaseAssignment({ model: 'planning' }, settings, reg)

    expect(r.resolvedFromAlias).toBe(true)
    expect(r.provider).toBe('anthropic')
    expect(r.model).toBe('claude-opus-4-1')
    expect(r.modelHints).toBeUndefined()
  })

  it('propagates reasoningEffort from the alias entry into modelHints', () => {
    const reg = buildRegistry()
    const settings = makeSettings({
      aliases: {
        planning: {
          provider: 'openai',
          model: 'gpt-5-pro',
          reasoningEffort: 'high',
        },
      },
    })

    const r = resolvePhaseAssignment({ model: 'planning' }, settings, reg)

    expect(r.resolvedFromAlias).toBe(true)
    expect(r.provider).toBe('openai')
    expect(r.model).toBe('gpt-5-pro')
    expect(r.modelHints).toEqual({ reasoningEffort: 'high' })
  })

  it('treats unknown keys as literal model ids (no alias hit)', () => {
    const reg = buildRegistry()
    const settings = makeSettings({})

    const r = resolvePhaseAssignment({ model: 'claude-sonnet-4-5' }, settings, reg)

    expect(r.resolvedFromAlias).toBe(false)
    expect(r.provider).toBe('anthropic')
    expect(r.model).toBe('claude-sonnet-4-5')
  })

  it('lets an explicit phase `provider:` override the alias provider', () => {
    const reg = buildRegistry()
    const settings = makeSettings({
      // Alias points at openai, but the workflow author wrote provider: anthropic.
      aliases: { coding: { provider: 'openai', model: 'claude-sonnet-4-5' } },
    })

    const r = resolvePhaseAssignment(
      { model: 'coding', provider: 'anthropic' },
      settings,
      reg,
    )

    expect(r.resolvedFromAlias).toBe(true)
    // Workflow override wins over alias.provider.
    expect(r.provider).toBe('anthropic')
    // But the alias's `model` is preserved.
    expect(r.model).toBe('claude-sonnet-4-5')
  })

  it('returns the executor capabilities snapshot for the prompt builder', () => {
    const reg = buildRegistry()
    const settings = makeSettings({})

    const r = resolvePhaseAssignment({ model: 'claude-sonnet-4-5' }, settings, reg)

    expect(r.capabilities).toBe(r.runtime.capabilities)
    expect(r.capabilities.supportsNativeSubagents).toBe(false)
  })
})

describe('resolveModelAlias (shared resolution core)', () => {
  const aliases = {
    'tier:planning': { provider: 'anthropic', model: 'claude-opus-4-8' },
    'tier:coding': { provider: 'openai', model: 'gpt-5.6-terra', reasoningEffort: 'high' as const },
    coding: { provider: 'anthropic', model: 'legacy-coding' },
  }

  it('resolves tier:* first and carries provider + reasoningEffort', () => {
    const r = resolveModelAlias({ tier: 'coding' }, aliases)
    expect(r).toMatchObject({
      model: 'gpt-5.6-terra',
      provider: 'openai',
      reasoningEffort: 'high',
      resolvedFromAlias: true,
      aliasKey: 'tier:coding',
    })
  })

  it('defaults an undeclared phase to the planning tier', () => {
    expect(resolveModelAlias({}, aliases).model).toBe('claude-opus-4-8')
    expect(resolveModelAlias(null, aliases).aliasKey).toBe('tier:planning')
  })

  it('treats an explicit model as an alias key first, then a literal', () => {
    expect(resolveModelAlias({ model: 'coding' }, aliases).aliasKey).toBe('coding')
    const literal = resolveModelAlias({ model: 'claude-haiku-4-5' }, aliases)
    expect(literal).toMatchObject({ model: 'claude-haiku-4-5', resolvedFromAlias: false })
    expect(literal.reasoningEffort).toBeUndefined()
  })

  it('falls back to the bare tier as a literal when nothing matches', () => {
    const r = resolveModelAlias({ tier: 'mini' }, aliases)
    expect(r).toMatchObject({ model: 'mini', resolvedFromAlias: false })
  })
})
