import { describe, it, expect, beforeEach } from 'vitest'
import type { PluginRegistry } from '../../src/plugins/registry'
import type { Settings } from '../../src/config/settings'
import {
  resetIntakeSessionBudgetsForTests,
  runIntakeStream,
} from '../../src/intake/handler'

const settings = {} as Settings

function mockRegistry(output: string) {
  return {
    resolveExecutor: () => ({
      runSubagent: async () => ({
        output,
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    }),
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
})
