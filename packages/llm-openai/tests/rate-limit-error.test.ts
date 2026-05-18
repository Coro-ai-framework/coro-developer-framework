import { describe, it, expect } from 'vitest'
import pino from 'pino'
import { createSdkMcpServer, RateLimitExceededError } from '@coro/plugin-sdk'
import { createOpenAiExecutor } from '../src/executor'

const silentLogger = pino({ level: 'silent' })

function makeEmptyCoroServer() {
  return createSdkMcpServer({ name: 'coro', tools: [] })
}

async function drain(iter: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const ev of iter) out.push(ev)
  return out
}

describe('OpenAiExecutor — rate-limit classification', () => {
  it('rethrows 429 with Retry-After as RateLimitExceededError(provider=openai)', async () => {
    const client = {
      responses: {
        create: async () => {
          const err = Object.assign(new Error('rate limit'), {
            status: 429,
            headers: new Headers({ 'retry-after': '30' }),
          })
          throw err
        },
      },
    }
    const ex = createOpenAiExecutor({ auth: { apiKey: 'sk-test' }, logger: silentLogger, client })
    const coroServer = makeEmptyCoroServer()

    let caught: unknown
    try {
      await drain(
        ex.executePhase({
          systemPrompt: 's',
          userPrompt: 'u',
          model: 'gpt-5.4',
          cwd: process.cwd(),
          intelligenceDir: process.cwd(),
          mcpServer: { kind: 'sdk-instance', id: 'coro', instance: coroServer },
          pluginMcpServers: {},
          hookPolicy: { allowedTools: null, writeRoots: [process.cwd()] },
          sessionState: {},
          maxTurns: 3,
          signal: new AbortController().signal,
        }),
      )
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(RateLimitExceededError)
    const rle = caught as RateLimitExceededError
    expect(rle.provider).toBe('openai')
    expect(rle.info.kind).toBe('rate-limit')
    expect(rle.info.retryAfterMs).toBe(30_000)
    expect(rle.info.source).toBe('retry-after')
    expect(rle.cause).toBeDefined()
  })

  it('leaves non-rate-limit errors untouched', async () => {
    const original = new Error('boom')
    const client = {
      responses: {
        create: async () => {
          throw original
        },
      },
    }
    const ex = createOpenAiExecutor({ auth: { apiKey: 'sk-test' }, logger: silentLogger, client })
    const coroServer = makeEmptyCoroServer()

    let caught: unknown
    try {
      await drain(
        ex.executePhase({
          systemPrompt: 's',
          userPrompt: 'u',
          model: 'gpt-5.4',
          cwd: process.cwd(),
          intelligenceDir: process.cwd(),
          mcpServer: { kind: 'sdk-instance', id: 'coro', instance: coroServer },
          pluginMcpServers: {},
          hookPolicy: { allowedTools: null, writeRoots: [process.cwd()] },
          sessionState: {},
          maxTurns: 3,
          signal: new AbortController().signal,
        }),
      )
    } catch (err) {
      caught = err
    }

    expect(caught).toBe(original)
    expect(caught).not.toBeInstanceOf(RateLimitExceededError)
  })

  it('treats 529 overloaded as RateLimitExceededError with kind=overloaded', async () => {
    const client = {
      responses: {
        create: async () => {
          throw Object.assign(new Error('overloaded'), { status: 529 })
        },
      },
    }
    const ex = createOpenAiExecutor({ auth: { apiKey: 'sk-test' }, logger: silentLogger, client })
    const coroServer = makeEmptyCoroServer()

    let caught: unknown
    try {
      await drain(
        ex.executePhase({
          systemPrompt: 's',
          userPrompt: 'u',
          model: 'gpt-5.4',
          cwd: process.cwd(),
          intelligenceDir: process.cwd(),
          mcpServer: { kind: 'sdk-instance', id: 'coro', instance: coroServer },
          pluginMcpServers: {},
          hookPolicy: { allowedTools: null, writeRoots: [process.cwd()] },
          sessionState: {},
          maxTurns: 3,
          signal: new AbortController().signal,
        }),
      )
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(RateLimitExceededError)
    expect((caught as RateLimitExceededError).info.kind).toBe('overloaded')
  })
})
