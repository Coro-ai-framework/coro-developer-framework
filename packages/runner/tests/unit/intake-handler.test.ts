import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { RateLimitExceededError } from '@coro-ai/plugin-sdk'
import type { PluginRegistry } from '../../src/plugins/registry'
import type { Settings } from '../../src/config/settings'
import { resetIntakeSessionsForTests, runIntakeStream } from '../../src/intake/handler'

const settings = { intake: { toolsEnabled: true } } as Settings

let tmpHome: string
let savedHome: string | undefined

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-intake-mcp-'))
  fs.mkdirSync(path.join(tmpHome, '.coro'), { recursive: true })
  savedHome = process.env['HOME']
  process.env['HOME'] = tmpHome
  resetIntakeSessionsForTests()
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

async function collectEvents(sessionId: string, message: string) {
  const events = []
  for await (const event of runIntakeStream({
    sessionId,
    message,
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
    const events = await collectEvents('session-a', 'Add logging')
    expect(events.some(e => e.type === 'token')).toBe(true)
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      turns: 1,
    })
  })

  it('does not cap turns or tokens — an investigation runs as long as it needs', async () => {
    for (let i = 0; i < 12; i++) {
      const events = await collectEvents('session-b', `turn ${i}`)
      expect(events.at(-1)).toMatchObject({ type: 'done', turns: i + 1 })
    }
    const events = await collectEvents('session-b', 'still going')
    expect(events.some(e => e.type === 'error')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'done', turns: 13, sessionTokens: 13 * 150 })
  })

  it('preserves line breaks in the streamed reply', async () => {
    const reply = 'Findings:\n\n- The handler is stateless\n- Tool results are dropped\n\n<readiness>\n{"state":"investigating"}\n</readiness>'
    const events = []
    for await (const event of runIntakeStream({
      sessionId: 'session-multiline',
      message: 'What did you find?',
      context: { recentRepos: [], recentReviewers: [], availableWorkflows: [] },
      registry: mockRegistry(reply),
      settings,
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }
    const streamed = events
      .filter((e): e is { type: 'token'; text: string } => e.type === 'token')
      .map(e => e.text)
      .join('')
    expect(streamed).toBe(reply)
  })

  it('rejects a turn with no user message instead of synthesizing a greeting', async () => {
    const events = await collectEvents('session-empty', '   ')
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
      message: 'Hi',
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
      message: 'Add logging',
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
      message: 'Hello',
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
      contextTokens: 15,
    })
  })

  it('carries prior turns and their tool evidence into the next turn', async () => {
    const seen: Array<ReadonlyArray<{ role: string; content: string }>> = []
    let turn = 0
    const registry = {
      all: () => [],
      resolveExecutor: () => ({
        chat: async (req: { messages: ReadonlyArray<{ role: string; content: string }> }) => {
          seen.push(req.messages)
          turn += 1
          return {
            output: `reply ${turn}`,
            usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
            toolCalls:
              turn === 1
                ? [{
                    name: 'scm_read_file',
                    input: { repo: 'org/x', path: 'src/api.ts' },
                    output: 'export const rateLimit = 100',
                    durationMs: 3,
                  }]
                : [],
          }
        },
      }),
    } as unknown as PluginRegistry

    for (const message of ['what is in src/api.ts?', 'so where is the limit set?']) {
      for await (const _event of runIntakeStream({
        sessionId: 'session-evidence',
        message,
        context: { recentRepos: [], recentReviewers: [], availableWorkflows: [] },
        registry,
        settings,
        signal: new AbortController().signal,
      })) {
        // drain
      }
    }

    expect(seen[0]).toEqual([{ role: 'user', content: 'what is in src/api.ts?' }])
    expect(seen[1]).toHaveLength(3)
    expect(seen[1]![0]).toEqual({ role: 'user', content: 'what is in src/api.ts?' })
    expect(seen[1]![1]!.role).toBe('assistant')
    expect(seen[1]![1]!.content).toContain('reply 1')
    expect(seen[1]![1]!.content).toContain('<evidence>')
    expect(seen[1]![1]!.content).toContain('export const rateLimit = 100')
    expect(seen[1]![2]).toEqual({ role: 'user', content: 'so where is the limit set?' })
  })

  it('seeds a session from a client transcript when the runner has no state', async () => {
    const seen: Array<ReadonlyArray<{ role: string; content: string }>> = []
    const registry = {
      all: () => [],
      resolveExecutor: () => ({
        chat: async (req: { messages: ReadonlyArray<{ role: string; content: string }> }) => {
          seen.push(req.messages)
          return {
            output: 'ok',
            usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
            toolCalls: [],
          }
        },
      }),
    } as unknown as PluginRegistry

    for await (const _event of runIntakeStream({
      sessionId: 'session-seeded',
      message: 'and the retries?',
      seedMessages: [
        { role: 'user', content: 'how does the client time out?' },
        { role: 'assistant', content: 'It uses a 5s deadline.' },
      ],
      context: { recentRepos: [], recentReviewers: [], availableWorkflows: [] },
      registry,
      settings,
      signal: new AbortController().signal,
    })) {
      // drain
    }

    expect(seen[0]).toEqual([
      { role: 'user', content: 'how does the client time out?' },
      { role: 'assistant', content: 'It uses a 5s deadline.' },
      { role: 'user', content: 'and the retries?' },
    ])
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
      message: 'What is PROJ-42 about?',
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

  it('streams thinking and text while chat() is still running, and does not dump them again at the end', async () => {
    const registry = {
      all: () => [],
      resolveExecutor: () => ({
        chat: async (req: {
          onText?: (content: string) => void
          onThinking?: (content: string) => void
          onToolStart?: (info: { name: string; input: unknown }) => void
          onToolEnd?: (record: { name: string; input: unknown; output: unknown; durationMs: number }) => void
        }) => {
          req.onThinking?.('The handler looks stateless.')
          req.onText?.('I am going to read the intake handler.\n')
          req.onToolStart?.({ name: 'scm_read_file', input: { path: 'handler.ts' } })
          req.onToolEnd?.({
            name: 'scm_read_file',
            input: { path: 'handler.ts' },
            output: 'async function* runIntakeStream',
            durationMs: 4,
          })
          req.onText?.('Tool results are dropped at the turn boundary.')
          return {
            output: 'I am going to read the intake handler.\nTool results are dropped at the turn boundary.',
            usage: { inputTokens: 20, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
            toolCalls: [{
              name: 'scm_read_file',
              input: { path: 'handler.ts' },
              output: 'async function* runIntakeStream',
              durationMs: 4,
            }],
          }
        },
      }),
    } as unknown as PluginRegistry

    const events: Array<Record<string, unknown>> = []
    for await (const event of runIntakeStream({
      sessionId: 'session-live-text',
      message: 'Why is plan mode silent?',
      context: { recentRepos: [], recentReviewers: [], availableWorkflows: [] },
      registry,
      settings,
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    const types = events.map(e => e.type)
    expect(types.filter(t => t === 'thinking')).toEqual(['thinking'])
    expect(events.find(e => e.type === 'thinking')).toMatchObject({
      type: 'thinking',
      text: 'The handler looks stateless.',
    })
    expect(events.find(e => e.type === 'tool_start')).toMatchObject({
      type: 'tool_start',
      name: 'scm_read_file',
    })
    const streamed = events
      .filter((e): e is { type: 'token'; text: string } => e.type === 'token')
      .map(e => e.text)
      .join('')
    expect(streamed).toBe(
      'I am going to read the intake handler.\nTool results are dropped at the turn boundary.',
    )
    // Live onText already carried the reply — dumping result.output would double it.
    expect(types.filter(t => t === 'token').length).toBe(2)
    expect(types.at(-1)).toBe('done')
    expect(types.indexOf('thinking')).toBeLessThan(types.indexOf('token'))
    expect(types.indexOf('token')).toBeLessThan(types.indexOf('tool_start'))
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
            output: 'Run ready.',
            usage: { inputTokens: 5, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
            toolCalls: [],
          }
        },
      }),
    } as unknown as PluginRegistry

    const events = []
    for await (const event of runIntakeStream({
      sessionId: 'session-plan-mcp',
      message: 'Who calls world?',
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

  it('round-trips executor sessionState and a stable work root across turns', async () => {
    const seen: Array<{ sessionState?: unknown; cwd?: string }> = []
    const registry = {
      all: () => [],
      resolveExecutor: () => ({
        manifest: { id: 'anthropic' },
        chat: async (req: { sessionState?: unknown; cwd?: string }) => {
          seen.push({ sessionState: req.sessionState, cwd: req.cwd })
          return {
            output: 'ok',
            usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
            toolCalls: [],
            sessionState: { sessionId: 'claude-plan-1' },
          }
        },
      }),
    } as unknown as PluginRegistry

    for (const message of ['look at auth', 'and the refresh path?']) {
      for await (const _event of runIntakeStream({
        sessionId: 'session-resume',
        message,
        context: { recentRepos: [], recentReviewers: [], availableWorkflows: [] },
        registry,
        settings,
        signal: new AbortController().signal,
      })) {
        // drain
      }
    }

    expect(seen).toHaveLength(2)
    expect(seen[0]?.sessionState).toBeUndefined()
    expect(seen[1]?.sessionState).toEqual({ sessionId: 'claude-plan-1' })
    expect(seen[0]?.cwd).toBeTruthy()
    expect(seen[1]?.cwd).toBe(seen[0]?.cwd)
  })

  it('keeps the conversation after a rate-limit and tells the developer to send again', async () => {
    let turn = 0
    const seen: Array<unknown> = []
    const registry = {
      all: () => [],
      resolveExecutor: () => ({
        manifest: { id: 'anthropic' },
        chat: async (req: { sessionState?: unknown }) => {
          seen.push(req.sessionState)
          turn += 1
          if (turn === 2) {
            throw new RateLimitExceededError('anthropic', {
              kind: 'rate-limit',
              retryAfterMs: 5000,
              source: 'fallback',
            })
          }
          return {
            output: `ok ${turn}`,
            usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
            toolCalls: [],
            sessionState: { sessionId: 'claude-plan-1' },
          }
        },
      }),
    } as unknown as PluginRegistry

    const drain = async (message: string) => {
      const events = []
      for await (const event of runIntakeStream({
        sessionId: 'session-rate-limit',
        message,
        context: { recentRepos: [], recentReviewers: [], availableWorkflows: [] },
        registry,
        settings,
        signal: new AbortController().signal,
      })) {
        events.push(event)
      }
      return events
    }

    expect((await drain('first')).at(-1)).toMatchObject({ type: 'done' })
    const limited = await drain('second')
    expect(limited.some(e => e.type === 'error')).toBe(true)
    expect(limited.find(e => e.type === 'error')?.message).toMatch(/still open/)
    const resumed = await drain('third')
    expect(resumed.at(-1)).toMatchObject({ type: 'done' })
    expect(seen[1]).toEqual({ sessionId: 'claude-plan-1' })
    expect(seen[2]).toEqual({ sessionId: 'claude-plan-1' })
  })
})
