// Tests for `PluginRegistry.resolveExecutor()` — the bridge between the
// workflow YAML's `provider:`/`model:` fields and the executor plugin
// runtime that runs the phase. Exercises every branch of the 4-tier
// resolution order plus the ambiguity / not-installed errors.

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  PluginRegistry,
  PluginResolutionError,
} from '../../src/plugins'
import type {
  ExecutorCapabilities,
  ExecutorModelDescriptor,
  PhaseExecutionRequest,
  PhaseExecutorEvent,
  PhaseExecutorRuntime,
} from '../../src/plugins/types'
import type { PluginManifest } from '@coro/plugin-sdk'

// ── Fake executor builder ────────────────────────────────────────────────────

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

interface FakeOpts {
  id: string
  /** Models this executor `supports()`; defaults to id-prefix. */
  prefix?: string
  models?: ExecutorModelDescriptor[]
}

function makeFakeExecutor(opts: FakeOpts): PhaseExecutorRuntime {
  const manifest: PluginManifest = {
    id: opts.id,
    kind: 'executor',
    version: '1.0.0',
    displayName: opts.id,
    hostCompatibility: '*',
    configSchema: z.object({}).passthrough(),
  }
  const prefix = opts.prefix ?? `${opts.id}-`
  return {
    manifest,
    kind: 'executor' as const,
    capabilities: ZERO_CAPS,
    listModels: () => opts.models ?? [],
    supports: (model: string) => model.startsWith(prefix),
    // eslint-disable-next-line @typescript-eslint/require-await
    executePhase: async function* (_req: PhaseExecutionRequest): AsyncIterable<PhaseExecutorEvent> {
      void _req
    },
    async init() { /* no-op */ },
    async healthcheck() { return { ok: true } },
    async dispose() { /* no-op */ },
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PluginRegistry.resolveExecutor', () => {
  it('resolves the explicit provider when installed', () => {
    const reg = new PluginRegistry()
    const anthropic = makeFakeExecutor({ id: 'anthropic', prefix: 'claude-' })
    const openai = makeFakeExecutor({ id: 'openai', prefix: 'gpt-' })
    reg.register(anthropic)
    reg.register(openai)

    const r = reg.resolveExecutor({ provider: 'openai' })
    expect(r.manifest.id).toBe('openai')
  })

  it('throws PluginResolutionError when explicit provider is not installed', () => {
    const reg = new PluginRegistry()
    reg.register(makeFakeExecutor({ id: 'anthropic', prefix: 'claude-' }))

    expect(() => reg.resolveExecutor({ provider: 'openai' })).toThrow(PluginResolutionError)
  })

  it('throws when explicit provider is the wrong kind', () => {
    const reg = new PluginRegistry()
    // Register a non-executor plugin under the same id to force a kind mismatch.
    reg.register({
      manifest: {
        id: 'fake-scm',
        kind: 'scm',
        version: '1.0.0',
        displayName: 'fake',
        hostCompatibility: '*',
        configSchema: z.object({}),
      },
      async init() { /* no-op */ },
      async healthcheck() { return { ok: true } },
      async dispose() { /* no-op */ },
    } as never) // SCM-shaped fake; the test only cares about kind validation.

    expect(() => reg.resolveExecutor({ provider: 'fake-scm' })).toThrow(
      /registered as kind "scm"/,
    )
  })

  it('infers the executor when exactly one supports() the model', () => {
    const reg = new PluginRegistry()
    reg.register(makeFakeExecutor({ id: 'anthropic', prefix: 'claude-' }))
    reg.register(makeFakeExecutor({ id: 'openai', prefix: 'gpt-' }))

    const r = reg.resolveExecutor({ model: 'gpt-4o-mini' })
    expect(r.manifest.id).toBe('openai')
  })

  it('throws PluginResolutionError when multiple executors support the model', () => {
    const reg = new PluginRegistry()
    // Two plugins that both claim the same model prefix.
    reg.register(makeFakeExecutor({ id: 'anthropic-a', prefix: 'claude-' }))
    reg.register(makeFakeExecutor({ id: 'anthropic-b', prefix: 'claude-' }))

    expect(() => reg.resolveExecutor({ model: 'claude-sonnet-4-5' })).toThrow(
      /Multiple executor plugins support model "claude-sonnet-4-5"/,
    )
  })

  it('falls back to the tenant default when model is unknown', () => {
    const reg = new PluginRegistry()
    reg.register(makeFakeExecutor({ id: 'anthropic', prefix: 'claude-' }))
    reg.register(makeFakeExecutor({ id: 'openai', prefix: 'gpt-' }))
    reg.setDefaults({ executor: 'openai' })

    const r = reg.resolveExecutor({ model: 'mystery-model-1' })
    expect(r.manifest.id).toBe('openai')
  })

  it('falls back to the sole installed executor when no default is set', () => {
    const reg = new PluginRegistry()
    const only = makeFakeExecutor({ id: 'anthropic', prefix: 'claude-' })
    reg.register(only)

    const r = reg.resolveExecutor({})
    expect(r.manifest.id).toBe('anthropic')
  })

  it('throws when no executor is installed at all', () => {
    const reg = new PluginRegistry()

    expect(() => reg.resolveExecutor({})).toThrow(/No executor plugin installed/)
  })
})
