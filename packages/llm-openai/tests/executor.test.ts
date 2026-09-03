import { describe, it, expect } from 'vitest'
import pino from 'pino'
import { tool, createSdkMcpServer } from '@coro-ai/plugin-sdk'
import { z } from 'zod'
import {
  OpenAiExecutor,
  createOpenAiExecutor,
} from '../src/executor'
import { calculateOpenAiCostUsd } from '../src/models'

const silentLogger = pino({ level: 'silent' })

function makeExecutor() {
  return createOpenAiExecutor({
    auth: { apiKey: 'sk-test' },
    logger: silentLogger,
  })
}

describe('OpenAiExecutor — manifest', () => {
  it('declares id="openai" / kind="executor" / version=1.x', () => {
    const ex = makeExecutor()
    expect(ex.manifest.id).toBe('openai')
    expect(ex.manifest.kind).toBe('executor')
    expect(ex.kind).toBe('executor')
    expect(ex.manifest.version).toMatch(/^1\./)
    expect(ex.manifest.displayName).toContain('OpenAI')
    expect(ex.manifest.capabilities?.supportsResponsesApi).toBe(true)
  })
})

describe('OpenAiExecutor — capabilities', () => {
  it('reports stateless replay and MCP-backed tool capabilities', () => {
    const ex = makeExecutor()
    expect(ex.capabilities).toMatchObject({
      supportsNativeSubagents: false,
      supportsClaudeMdNativeWalkUp: false,
      supportsNativeFileTools: false,
      supportsSessionResume: false,
      supportsConversationReplay: true,
      supportsThinking: true,
      supportsImageInput: true,
      maxContextTokens: 400_000,
    })
  })
})

describe('OpenAiExecutor — models', () => {
  it('returns a curated Responses API model catalogue', () => {
    const ids = makeExecutor().listModels().map(m => m.id)
    expect(ids).toContain('gpt-5.6-sol')
    expect(ids).toContain('gpt-5.6-terra')
    expect(ids).toContain('gpt-5.6-luna')
    expect(ids).toContain('gpt-5.5')
    expect(ids).toContain('gpt-5.3-codex')
    expect(ids).toContain('gpt-5.4-mini')
  })

  it('supports OpenAI-family model ids defensively', () => {
    const ex = makeExecutor()
    expect(ex.supports('gpt-5.5')).toBe(true)
    expect(ex.supports('gpt-4.1-mini-2025-04-14')).toBe(true)
    expect(ex.supports('o4-mini')).toBe(true)
    expect(ex.supports('claude-sonnet-4-6')).toBe(false)
    expect(ex.supports('')).toBe(false)
  })

  it('calculates cost from per-million token pricing', () => {
    const cost = calculateOpenAiCostUsd('gpt-5.5', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
    })
    expect(cost).toBeCloseTo(35.5, 5)
  })
})

describe('OpenAiExecutor — healthcheck', () => {
  it('reports ok=true when apiKey is present', async () => {
    await expect(makeExecutor().healthcheck()).resolves.toEqual({ ok: true })
  })

  it('reports ok=false when apiKey is missing', async () => {
    const ex = createOpenAiExecutor({ auth: {}, logger: silentLogger })
    const h = await ex.healthcheck()
    expect(h.ok).toBe(false)
    expect(h.reason).toMatch(/API key/)
  })
})

describe('OpenAiExecutor — executePhase', () => {
  it('runs a function-tool loop and persists conversationHistory', async () => {
    const calls: Array<Record<string, unknown>> = []
    const client = {
      responses: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params)
          if (calls.length === 1) {
            return {
              id: 'resp-1',
              output_text: '',
              usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 1 } },
              output: [
                {
                  type: 'function_call',
                  call_id: 'call-1',
                  name: 'mcp__coro__echo',
                  arguments: '{"message":"hi"}',
                },
              ],
            }
          }
          return {
            id: 'resp-2',
            output_text: 'done',
            status: 'completed',
            usage: { input_tokens: 5, output_tokens: 3 },
            output: [
              { type: 'message', content: [{ type: 'output_text', text: 'done' }] },
            ],
          }
        },
      },
    }
    const coroServer = createSdkMcpServer({
      name: 'coro',
      tools: [
        tool('echo', 'Echo a message.', { message: z.string() }, async ({ message }) => ({
          content: [{ type: 'text', text: `echo:${message}` }],
        })),
      ],
    })
    const ex = createOpenAiExecutor({
      auth: { apiKey: 'sk-test' },
      logger: silentLogger,
      client,
    })
    const events: unknown[] = []
    for await (const event of ex.executePhase({
      systemPrompt: 'system',
      userPrompt: 'use echo',
      model: 'gpt-5.4',
      cwd: process.cwd(),
      intelligenceDir: process.cwd(),
      mcpServer: { kind: 'sdk-instance', id: 'coro', instance: coroServer },
      pluginMcpServers: {},
      hookPolicy: { allowedTools: null, writeRoots: [process.cwd()] },
      sessionState: {},
      maxTurns: 5,
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(calls).toHaveLength(2)
    expect(calls[0].tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'mcp__coro__echo' }),
    ]))
    expect(calls[1].input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call_output', call_id: 'call-1', output: 'echo:hi' }),
    ]))
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_call', toolName: 'mcp__coro__echo' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'text', content: 'done' }))
    const done = events.find(e => typeof e === 'object' && e !== null && (e as { type?: string }).type === 'done')
    expect(done).toMatchObject({
      type: 'done',
      stopReason: 'completed',
      sessionState: { conversationHistory: expect.any(Array) },
    })
  })

  it('blocks disallowed tools before calling the MCP handler', async () => {
    let handlerCalls = 0
    const client = {
      responses: {
        create: async (params: Record<string, unknown>) => {
          if (!Array.isArray(params.input) || params.input.some(item => (item as { type?: string }).type === 'function_call_output')) {
            return { id: 'resp-2', output_text: 'blocked handled', usage: {}, output: [] }
          }
          return {
            id: 'resp-1',
            output_text: '',
            usage: {},
            output: [{ type: 'function_call', call_id: 'call-1', name: 'mcp__coro__danger', arguments: '{}' }],
          }
        },
      },
    }
    const coroServer = createSdkMcpServer({
      name: 'coro',
      tools: [tool('danger', 'Danger.', {}, async () => {
        handlerCalls++
        return { content: [{ type: 'text', text: 'bad' }] }
      })],
    })
    const ex = createOpenAiExecutor({ auth: { apiKey: 'sk-test' }, logger: silentLogger, client })
    const events: unknown[] = []
    for await (const event of ex.executePhase({
      systemPrompt: 'system',
      userPrompt: 'try danger',
      model: 'gpt-5.4',
      cwd: process.cwd(),
      intelligenceDir: process.cwd(),
      mcpServer: { kind: 'sdk-instance', id: 'coro', instance: coroServer },
      pluginMcpServers: {},
      hookPolicy: { allowedTools: ['mcp__coro__safe'], writeRoots: [process.cwd()] },
      sessionState: {},
      maxTurns: 3,
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }
    expect(handlerCalls).toBe(0)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      toolName: 'mcp__coro__danger',
      isError: true,
    }))
  })

  it('continues the phase after a steering interrupt instead of ending early', async () => {
    const calls: Array<Record<string, unknown>> = []
    let sessionController: { interrupt: () => Promise<void> } | undefined
    let firstCreateEntered!: () => void
    const firstCreatePromise = new Promise<void>(resolve => {
      firstCreateEntered = resolve
    })
    const developerInput = {
      push: (_message: unknown) => { /* wired by executor */ },
      close: () => { /* wired by executor */ },
    }

    let apiAttempt = 0
    const client = {
      responses: {
        create: async (params: Record<string, unknown>, opts?: { signal?: AbortSignal }) => {
          apiAttempt++
          if (apiAttempt === 1) {
            firstCreateEntered()
            await new Promise<void>((_, reject) => {
              const signal = opts?.signal
              if (!signal) {
                reject(new Error('missing signal'))
                return
              }
              if (signal.aborted) {
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
                return
              }
              signal.addEventListener('abort', () => {
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
              }, { once: true })
            })
          }
          calls.push(params)
          return {
            id: 'resp-after-steer',
            output_text: 'continued',
            status: 'completed',
            usage: { input_tokens: 3, output_tokens: 2 },
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'continued' }] }],
          }
        },
      },
    }

    const coroServer = createSdkMcpServer({ name: 'coro', tools: [] })
    const ex = createOpenAiExecutor({
      auth: { apiKey: 'sk-test' },
      logger: silentLogger,
      client,
    })

    const events: unknown[] = []
    const run = (async () => {
      for await (const event of ex.executePhase({
        systemPrompt: 'system',
        userPrompt: 'start work',
        model: 'gpt-5.4',
        cwd: process.cwd(),
        intelligenceDir: process.cwd(),
        mcpServer: { kind: 'sdk-instance', id: 'coro', instance: coroServer },
        pluginMcpServers: {},
        hookPolicy: { allowedTools: null, writeRoots: [process.cwd()] },
        sessionState: {},
        maxTurns: 5,
        signal: new AbortController().signal,
        developerInput,
        lifecycle: {
          onSessionStart: (controller) => {
            sessionController = controller
          },
        },
      })) {
        events.push(event)
      }
    })()

    await firstCreatePromise
    expect(sessionController).toBeDefined()

    developerInput.push({
      role: 'user',
      content: '[DEVELOPER MESSAGE]\n"Adjust the plan"',
    })
    await sessionController!.interrupt()

    await run

    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('Adjust the plan') }),
    ]))
    const doneEvents = events.filter(
      e => typeof e === 'object' && e !== null && (e as { type?: string }).type === 'done',
    )
    expect(doneEvents).toHaveLength(1)
    expect(doneEvents[0]).toMatchObject({ stopReason: 'completed' })
    expect(events).toContainEqual(expect.objectContaining({ type: 'text', content: 'continued' }))
  })

  it('emits cumulative totalCostUsd on each usage event so the runner can book per-phase cost', async () => {
    const client = {
      responses: {
        create: async () => ({
          id: 'resp-cost-1',
          output_text: 'ok',
          status: 'completed',
          usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        }),
      },
    }
    const ex = createOpenAiExecutor({
      auth: { apiKey: 'sk-test' },
      logger: silentLogger,
      client,
    })
    const usageEvents: Array<{ tokens: { totalCostUsd?: number } }> = []
    for await (const event of ex.executePhase({
      systemPrompt: 'system',
      userPrompt: 'go',
      model: 'gpt-5.4',
      cwd: process.cwd(),
      intelligenceDir: process.cwd(),
      mcpServer: { kind: 'sdk-instance', id: 'coro', instance: createSdkMcpServer({ name: 'coro', tools: [] }) },
      pluginMcpServers: {},
      hookPolicy: { allowedTools: null, writeRoots: [process.cwd()] },
      sessionState: {},
      maxTurns: 5,
      signal: new AbortController().signal,
    })) {
      if (event.type === 'usage') usageEvents.push(event as { tokens: { totalCostUsd?: number } })
    }
    const final = usageEvents.at(-1)
    expect(final).toBeDefined()
    // gpt-5.4 pricing: input $2.5/M, output $15/M → 1M*2.5 + 0.1M*15 = $2.5 + $1.5 = $4
    expect(final!.tokens.totalCostUsd).toBeCloseTo(4, 5)
  })
})

describe('OpenAiExecutor — chat session replay', () => {
  it('returns conversationHistory and replays it instead of the textual transcript', async () => {
    const inputs: unknown[][] = []
    const client = {
      responses: {
        create: async (params: Record<string, unknown>) => {
          inputs.push(params.input as unknown[])
          return {
            output_text: inputs.length === 1 ? 'first' : 'second',
            usage: { input_tokens: 4, output_tokens: 2 },
            output: [{ type: 'message', content: [{ type: 'output_text', text: inputs.length === 1 ? 'first' : 'second' }] }],
          }
        },
      },
    }
    const ex = createOpenAiExecutor({ auth: { apiKey: 'sk-test' }, logger: silentLogger, client })
    const first = await ex.chat({
      messages: [{ role: 'user', content: 'What does login do?' }],
      model: 'gpt-5.4',
      signal: new AbortController().signal,
    })
    expect(first.output).toBe('first')
    expect(first.sessionState?.conversationHistory?.length).toBeGreaterThan(0)

    const second = await ex.chat({
      messages: [
        { role: 'user', content: 'What does login do?' },
        { role: 'assistant', content: 'first' },
        { role: 'user', content: 'And logout?' },
      ],
      sessionState: first.sessionState,
      model: 'gpt-5.4',
      signal: new AbortController().signal,
    })
    expect(second.output).toBe('second')
    expect(inputs[1]).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'What does login do?' }),
      expect.objectContaining({ role: 'user', content: 'And logout?' }),
    ]))
    expect(inputs[1]?.some(item => item && typeof item === 'object' && (item as { content?: string }).content === 'first')).toBe(true)
  })
})

describe('OpenAiExecutor — class identity', () => {
  it('factory returns an instance of OpenAiExecutor', () => {
    expect(makeExecutor()).toBeInstanceOf(OpenAiExecutor)
  })
})
