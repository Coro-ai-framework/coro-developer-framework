import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import type { PluginRegistry } from '../../src/plugins/registry'
import type { Settings } from '../../src/config/settings'
import {
  resetIntakeSessionBudgetsForTests,
  runIntakeStream,
} from '../../src/intake/handler'

const settings = { intake: { toolsEnabled: true } } as Settings

let tmpHome: string
let savedHome: string | undefined

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-intake-mcp-'))
  fs.mkdirSync(path.join(tmpHome, '.coro'), { recursive: true })
  savedHome = process.env['HOME']
  process.env['HOME'] = tmpHome
  resetIntakeSessionBudgetsForTests()
})

afterEach(() => {
  if (savedHome !== undefined) process.env['HOME'] = savedHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

function writeMcpConfig(mcpServers: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(tmpHome, '.coro', 'config.json'),
    JSON.stringify({ mcpServers }, null, 2),
  )
}

function mockRegistry(output: string, onResolve?: (req: { model?: string; provider?: string }) => void) {
  return {
    all: () => [],
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
        message: 'Session turn limit reached. Start a new conversation, or dispatch the brief you have.',
      },
    ])
  })

  it('rejects a turn with no user message instead of synthesizing a greeting', async () => {
    const events = await collectEvents('session-empty', [])
    expect(events).toEqual([
      {
        type: 'error',
        message: 'Plan mode did not receive a user message. Try sending again.',
      },
    ])
  })

  it('returns no-llm error when executor cannot be resolved', async () => {
    const registry = {
      all: () => [],
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
      all: () => [],
      resolveExecutor: () => ({
        chat: async () => {
          calls.chat += 1
          return { output: 'chat path', usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, toolCalls: [] }
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

  it('streams tool_start/tool_end with rich summaries when the executor invokes a tool', async () => {
    const getIssue = async (key: string) => ({ key, url: 'u', summary: 'Hello', status: 'open' })
    const trackerPlugin = {
      manifest: { id: 'jira', kind: 'tracker' as const },
      kind: 'tracker' as const,
      getIssue,
    }

    const registry = {
      all: () => [trackerPlugin],
      resolveTracker: () => trackerPlugin,
      resolveScm: () => { throw new Error('no scm') },
      resolveExecutor: () => ({
        chat: async (req: {
          runTool?: (n: string, i: unknown) => Promise<unknown>
          onToolStart?: (info: { name: string; input: unknown }) => void
          onToolEnd?: (record: { name: string; input: unknown; output: unknown; durationMs: number; error?: string }) => void
        }) => {
          req.onToolStart?.({ name: 'tracker_get_issue', input: { key: 'PROJ-42' } })
          const output = await req.runTool!('tracker_get_issue', { key: 'PROJ-42' })
          req.onToolEnd?.({ name: 'tracker_get_issue', input: { key: 'PROJ-42' }, output, durationMs: 7 })
          return {
            output: 'Looked it up. Ready to plan.',
            usage: { inputTokens: 12, outputTokens: 8, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
            toolCalls: [{ name: 'tracker_get_issue', input: { key: 'PROJ-42' }, output, durationMs: 7 }],
          }
        },
      }),
    } as unknown as PluginRegistry

    const events: Array<Record<string, unknown>> = []
    for await (const event of runIntakeStream({
      sessionId: 'session-tool',
      messages: [{ role: 'user', content: 'What is PROJ-42 about?' }],
      context: { recentRepos: [], recentReviewers: [], availableWorkflows: [] },
      registry,
      settings,
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    const toolStart = events.find(e => e.type === 'tool_start')
    const toolEnd = events.find(e => e.type === 'tool_end')
    expect(toolStart).toMatchObject({
      type: 'tool_start',
      name: 'tracker_get_issue',
      input: { key: 'PROJ-42' },
    })
    expect(toolEnd).toMatchObject({
      type: 'tool_end',
      name: 'tracker_get_issue',
      ok: true,
      summary: 'Read PROJ-42',
    })
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('passes planMode BYO MCP servers to executor.chat() even without built-in tools', async () => {
    writeMcpConfig({
      catalog: {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        planMode: true,
      },
    })

    let captured: { pluginMcpServers?: Record<string, unknown> } = {}
    const registry = {
      all: () => [],
      resolveExecutor: () => ({
        chat: async (req: { pluginMcpServers?: Record<string, unknown> }) => {
          captured = req
          return {
            output: 'Brief ready.',
            usage: { inputTokens: 5, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
            toolCalls: [],
          }
        },
      }),
    } as unknown as PluginRegistry

    const events = []
    for await (const event of runIntakeStream({
      sessionId: 'session-plan-mcp',
      messages: [{ role: 'user', content: 'Who calls world?' }],
      context: { recentRepos: [], recentReviewers: [], availableWorkflows: [] },
      registry,
      settings,
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(captured.pluginMcpServers).toMatchObject({
      catalog: { type: 'stdio', command: 'node', args: ['server.js'] },
    })
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })
})
