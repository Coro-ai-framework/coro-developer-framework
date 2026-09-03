import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import pino from 'pino'
import { createAnthropicExecutor } from '../src/executor'
import { chatViaAgentSdk, shouldChatViaAgentSdk, type AnthropicChatHost } from '../src/chat-via-sdk'
import type { AnthropicExecutorSettings, ClaudeAuthConfig } from '../src/types'

let querySteps: Array<() => IteratorResult<unknown>> = []

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        async next(): Promise<IteratorResult<unknown>> {
          if (index < querySteps.length) return querySteps[index++]!()
          return { value: undefined, done: true }
        },
        async return(): Promise<IteratorResult<unknown>> {
          return { value: undefined, done: true }
        },
      }
    },
    interrupt: async () => {},
  }),
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({
    name,
    description,
    schema,
    handler,
  }),
  createSdkMcpServer: (opts: { name: string; tools: unknown[] }) => opts,
}))

vi.mock('../src/cli-path', () => ({
  resolveClaudeCodeCliPath: () => '/tmp/coro-fake-cli.js',
  ensureClaudeCodeCliExecutable: () => {},
}))

vi.mock('../src/intelligence-symlink', () => ({
  ensureClaudeConfigSymlink: () => {},
}))

vi.mock('../src/test-connection', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/test-connection')>()
  return {
    ...actual,
    testAnthropicCredentials: vi.fn(async () => ({ ok: true, message: 'Anthropic API accepted the credential.' })),
  }
})

vi.mock('../src/mcp-reattach', () => ({
  reattachDynamicMcpServers: async () => ({
    setResult: { added: [], removed: [], errors: {} },
    finalStatus: 'connected',
    reconnected: true,
  }),
}))

const silentLogger = pino({ level: 'silent' })

function makeSettings(): AnthropicExecutorSettings {
  return {
    bitbucket: {
      workspace: '',
      coderAccount: { username: '', appPassword: '' },
    },
  }
}

function successQuerySteps(): Array<() => IteratorResult<unknown>> {
  return [
    () => ({
      value: {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-chat-1',
        tools: [],
        mcp_servers: [],
      },
      done: false,
    }),
    () => ({
      value: {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Brief ready.' }],
          usage: { input_tokens: 12, output_tokens: 4 },
        },
      },
      done: false,
    }),
    () => ({
      value: {
        type: 'result',
        subtype: 'success',
        result: 'Brief ready.',
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 4 },
      },
      done: false,
    }),
  ]
}

describe('shouldChatViaAgentSdk', () => {
  it('returns true for claudeLogin and oauth', () => {
    expect(shouldChatViaAgentSdk({ method: 'claudeLogin' })).toBe(true)
    expect(shouldChatViaAgentSdk({ method: 'oauth', oauthToken: 'tok' })).toBe(true)
  })

  it('returns false for apiKey billing', () => {
    expect(shouldChatViaAgentSdk({ method: 'apiKey', apiKey: 'sk-ant-test' })).toBe(false)
  })
})

describe('AnthropicExecutor.chat routing', () => {
  beforeEach(() => {
    querySteps = successQuerySteps()
  })

  it('routes claudeLogin through executePhase (Agent SDK)', async () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings(),
      auth: { method: 'claudeLogin' } as ClaudeAuthConfig,
      logger: silentLogger,
    })

    const result = await ex.chat({
      messages: [{ role: 'user', content: 'Add logging to the API' }],
      systemPrompt: 'You are plan mode.',
      model: 'claude-opus-4-8',
      signal: new AbortController().signal,
    })

    expect(result.output).toBe('Brief ready.')
    expect(result.usage.inputTokens).toBe(12)
    expect(result.usage.outputTokens).toBe(4)
  })

  it('routes oauth through executePhase (Agent SDK)', async () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings(),
      auth: { method: 'oauth', oauthToken: 'oauth-test-token' },
      logger: silentLogger,
    })

    const result = await chatViaAgentSdk(ex, {
      messages: [{ role: 'user', content: 'Plan a refactor' }],
      systemPrompt: 'You are plan mode.',
      model: 'claude-sonnet-4-6',
      signal: new AbortController().signal,
    })

    expect(result.output).toBe('Brief ready.')
  })
})

describe('chatViaAgentSdk live callbacks', () => {
  it('forwards executePhase text and thinking to ChatRequest hooks', async () => {
    const onText = vi.fn()
    const onThinking = vi.fn()
    const host: AnthropicChatHost = {
      async *executePhase() {
        yield { type: 'thinking', content: 'I should look at the handler.' }
        yield { type: 'text', content: 'Checking the auth path.' }
        yield {
          type: 'usage',
          tokens: {
            inputTokens: 8,
            outputTokens: 4,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        }
      },
    }

    const result = await chatViaAgentSdk(host, {
      messages: [{ role: 'user', content: 'What does login do?' }],
      systemPrompt: 'You are plan mode.',
      model: 'claude-sonnet-4-6',
      signal: new AbortController().signal,
      onText,
      onThinking,
    })

    expect(onThinking).toHaveBeenCalledWith('I should look at the handler.')
    expect(onText).toHaveBeenCalledWith('Checking the auth path.')
    expect(result.output).toBe('Checking the auth path.')
    expect(result.usage.inputTokens).toBe(8)
  })
})

describe('chatViaAgentSdk with JSON Schema tools', () => {
  beforeEach(() => {
    querySteps = successQuerySteps()
  })

  it('registers plan-mode tools without requiring Zod input schemas', async () => {
    const ex = createAnthropicExecutor({
      settings: makeSettings(),
      auth: { method: 'claudeLogin' } as ClaudeAuthConfig,
      logger: silentLogger,
    })

    await expect(chatViaAgentSdk(ex, {
      messages: [{ role: 'user', content: 'Look up PROJ-1' }],
      model: 'claude-sonnet-4-6',
      signal: new AbortController().signal,
      tools: [{
        name: 'tracker_get_issue',
        description: 'Read a ticket',
        inputSchema: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key'],
        },
      }],
      runTool: async () => ({ key: 'PROJ-1' }),
    })).resolves.toMatchObject({ output: 'Brief ready.' })
  })
})

describe('AnthropicExecutor.chat apiKey REST path', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('uses direct /v1/messages for apiKey auth', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: 'REST hello' }],
      usage: { input_tokens: 3, output_tokens: 2 },
    }), { status: 200 })) as typeof fetch

    const ex = createAnthropicExecutor({
      settings: makeSettings(),
      auth: { method: 'apiKey', apiKey: 'sk-ant-test' },
      logger: silentLogger,
    })

    const result = await ex.chat({
      messages: [{ role: 'user', content: 'Hi' }],
      model: 'claude-haiku-4-5',
      signal: new AbortController().signal,
    })

    expect(result.output).toBe('REST hello')
    expect(global.fetch).toHaveBeenCalledOnce()
    expect(String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain('/v1/messages')
  })
})
