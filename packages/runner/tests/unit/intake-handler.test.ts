import { describe, it, expect, beforeEach } from 'vitest'
import type { PluginRegistry } from '../../src/plugins/registry'
import type { Settings } from '../../src/config/settings'
import {
  resetIntakeSessionBudgetsForTests,
  runIntakeStream,
} from '../../src/intake/handler'

const settings = {} as Settings

function mockRegistry(output: string, onResolve?: (req: { model?: string; provider?: string }) => void) {
  return {
    resolveExecutor: (req: { model?: string; provider?: string }) => {
      onResolve?.(req)
      return {
        runSubagent: async () => ({
          output,
          usage: { inputTokens: 100, outputTokens: 50 },
        }),
      }
    },
  } as unknown as PluginRegistry
}

async function collectEvents(sessionId: string, messages: Parameters<typeof runIntakeStream>[0]['messages']) {
  const events = []
  for await (const event of runIntakeStream({
    sessionId,
    messages,
    context: { recentRepos: [], recentReviewers: [], availableWorkflows: [] },
    registry: mockRegistry('Hello from intake'),
    settings,
    signal: new AbortController().signal,
  })) {
    events.push(event)
  }
  return events
}

describe('runIntakeStream', () => {
  beforeEach(() => {
    resetIntakeSessionBudgetsForTests()
  })

  it('streams tokens and completes with usage', async () => {
    const events = await collectEvents('session-a', [{ role: 'user', content: 'Add logging' }])
    expect(events.some(e => e.type === 'token')).toBe(true)
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    })
  })

  it('enforces the per-session turn limit', async () => {
    for (let i = 0; i < 8; i++) {
      await collectEvents('session-b', [{ role: 'user', content: `turn ${i}` }])
    }

    const events = await collectEvents('session-b', [{ role: 'user', content: 'one more' }])
    expect(events).toEqual([
      {
        type: 'error',
        message: 'Session turn limit reached. Please review the brief or switch to the form.',
      },
    ])
  })

  it('returns no-llm error when executor cannot be resolved', async () => {
    const registry = {
      resolveExecutor: () => {
        throw new Error('No LLM executor plugin registered')
      },
    } as unknown as PluginRegistry

    const events = []
    for await (const event of runIntakeStream({
      sessionId: 'session-c',
      messages: [{ role: 'user', content: 'Hi' }],
      context: { recentRepos: [], recentReviewers: [], availableWorkflows: [] },
      registry,
      settings,
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(events[0]).toMatchObject({
      type: 'error',
      message: 'Coro plan mode needs an LLM provider. Configure one in Settings.',
    })
  })

  it('uses an explicit model override when provided', async () => {
    const resolved: Array<{ model?: string; provider?: string }> = []
    const events = []
    for await (const event of runIntakeStream({
      sessionId: 'session-d',
      messages: [{ role: 'user', content: 'Add logging' }],
      context: { recentRepos: [], recentReviewers: [], availableWorkflows: [] },
      registry: mockRegistry('Hello', req => resolved.push(req)),
      settings,
      signal: new AbortController().signal,
      model: 'gpt-5.5',
      provider: 'openai',
    })) {
      events.push(event)
    }

    expect(resolved).toEqual([{ model: 'gpt-5.5', provider: 'openai' }])
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('prefers executor.chat() over runSubagent / executePhase', async () => {
    const calls: { chat: number; runSubagent: number } = { chat: 0, runSubagent: 0 }
    const registry = {
      resolveExecutor: () => ({
        chat: async () => {
          calls.chat += 1
          return { output: 'chat path', usage: { inputTokens: 10, outputTokens: 5 } }
        },
        runSubagent: async () => {
          calls.runSubagent += 1
          return { output: 'subagent path', usage: { inputTokens: 0, outputTokens: 0 } }
        },
      }),
    } as unknown as PluginRegistry

    const events = []
    for await (const event of runIntakeStream({
      sessionId: 'session-e',
      messages: [{ role: 'user', content: 'Hello' }],
      context: { recentRepos: [], recentReviewers: [], availableWorkflows: [] },
      registry,
      settings,
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(calls).toEqual({ chat: 1, runSubagent: 0 })
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    })
  })
})
