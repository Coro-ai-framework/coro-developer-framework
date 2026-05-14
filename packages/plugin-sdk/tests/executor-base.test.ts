// Lock-down tests for the executor authoring contracts. Verifies that
// PhaseExecutorBase enforces the right shape and supplies sane defaults
// (PluginBase.healthcheck, PluginBase.dispose, mcpServer undefined).

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { PhaseExecutorBase } from '../src/base'
import type {
  ExecutorCapabilities,
  ExecutorModelDescriptor,
  PhaseExecutionRequest,
  PhaseExecutorEvent,
  PluginManifest,
} from '../src/types'

const FIXTURE_CAPS: ExecutorCapabilities = {
  supportsNativeSubagents: false,
  supportsClaudeMdNativeWalkUp: false,
  supportsNativeFileTools: false,
  supportsSessionResume: false,
  supportsConversationReplay: true,
  supportsThinking: false,
  supportsImageInput: false,
  maxContextTokens: 100_000,
}

const FIXTURE_MANIFEST: PluginManifest = {
  id: 'test-executor',
  kind: 'executor',
  version: '0.0.1',
  displayName: 'Test Executor',
  hostCompatibility: '^1.0.0',
  configSchema: z.object({}),
}

class TestExecutor extends PhaseExecutorBase {
  readonly manifest = FIXTURE_MANIFEST
  readonly capabilities = FIXTURE_CAPS

  initCalls = 0

  async init(): Promise<void> {
    this.initCalls++
  }

  listModels(): ReadonlyArray<ExecutorModelDescriptor> {
    return [{ id: 'mock-1', displayName: 'Mock 1', contextTokens: 100_000 }]
  }

  supports(model: string): boolean {
    return model === 'mock-1'
  }

  async *executePhase(_req: PhaseExecutionRequest): AsyncIterable<PhaseExecutorEvent> {
    yield { type: 'text', content: 'hi' }
    yield {
      type: 'usage',
      tokens: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    }
    yield { type: 'done', stopReason: 'end_turn', sessionState: {} }
  }
}

describe('PhaseExecutorBase', () => {
  it('pins kind to "executor"', () => {
    const e = new TestExecutor()
    expect(e.kind).toBe('executor')
  })

  it('exposes manifest and capabilities to the runner', () => {
    const e = new TestExecutor()
    expect(e.manifest.id).toBe('test-executor')
    expect(e.manifest.kind).toBe('executor')
    expect(e.capabilities.supportsConversationReplay).toBe(true)
    expect(e.capabilities.supportsSessionResume).toBe(false)
  })

  it('inherits PluginBase.healthcheck default → ok:true', async () => {
    const e = new TestExecutor()
    await expect(e.healthcheck()).resolves.toEqual({ ok: true })
  })

  it('inherits PluginBase.dispose default → no-op', async () => {
    const e = new TestExecutor()
    await expect(e.dispose()).resolves.toBeUndefined()
  })

  it('mcpServer defaults to undefined', () => {
    const e = new TestExecutor()
    expect(e.mcpServer()).toBeUndefined()
  })

  it('intelligenceRoot defaults to undefined', () => {
    const e = new TestExecutor()
    expect(e.intelligenceRoot()).toBeUndefined()
  })

  it('listModels and supports() route correctly', () => {
    const e = new TestExecutor()
    const models = e.listModels()
    expect(models).toHaveLength(1)
    expect(e.supports('mock-1')).toBe(true)
    expect(e.supports('unknown')).toBe(false)
  })

  it('executePhase yields a normalized event stream ending in done', async () => {
    const e = new TestExecutor()
    const events: PhaseExecutorEvent[] = []
    for await (const ev of e.executePhase({} as PhaseExecutionRequest)) {
      events.push(ev)
    }
    expect(events.map((e) => e.type)).toEqual(['text', 'usage', 'done'])
    const last = events.at(-1)!
    expect(last.type).toBe('done')
  })
})
