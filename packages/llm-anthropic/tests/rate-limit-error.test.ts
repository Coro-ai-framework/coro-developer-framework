// Verifies that the Anthropic executor's executePhase() catches
// provider rate-limit / overloaded errors thrown by the Claude Agent
// SDK and rethrows them as RateLimitExceededError so the runner can
// park the job into STATUS_AWAITING_RATE_LIMIT.

import { describe, it, expect, vi } from 'vitest'

// Per-test scenario knob — set before calling executePhase. The mock
// `query()` reads it and emits the appropriate sequence. Avoids the
// hoisting trap with separate `vi.mock` calls per case.
type Scenario =
  | { kind: 'http-429' }
  | { kind: 'rate-limit-event'; resetsAt: number; errorMessage: string }
  | { kind: 'plain-message'; errorMessage: string }

let currentScenario: Scenario = { kind: 'http-429' }

// Mock the SDK so `query()` returns an async iterable that drives the scenario.
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: (_opts: unknown) => {
      const scenario = currentScenario
      const iterable: AsyncIterable<unknown> & { interrupt: () => Promise<void> } = {
        [Symbol.asyncIterator]() {
          let step = 0
          return {
            async next(): Promise<IteratorResult<unknown>> {
              if (scenario.kind === 'http-429') {
                const err = Object.assign(new Error('rate limit'), {
                  status: 429,
                  headers: new Headers({ 'retry-after': '45' }),
                })
                throw err
              }
              if (scenario.kind === 'rate-limit-event') {
                // First: emit the rate_limit_event system message.
                if (step++ === 0) {
                  return {
                    value: {
                      type: 'rate_limit_event',
                      rate_limit_info: {
                        status: 'rejected',
                        resetsAt: scenario.resetsAt,
                        rateLimitType: 'five_hour',
                      },
                      uuid: 'evt-1',
                      session_id: 'sess-1',
                    },
                    done: false,
                  }
                }
                // Then: throw the generic Error the subprocess surfaces.
                throw new Error(scenario.errorMessage)
              }
              // plain-message scenario
              throw new Error(scenario.errorMessage)
            },
            async return(): Promise<IteratorResult<unknown>> {
              return { value: undefined, done: true }
            },
          }
        },
        interrupt: async () => {},
      }
      return iterable
    },
  }
})

// Avoid touching the real Claude Code CLI on disk.
vi.mock('../src/cli-path', () => ({
  resolveClaudeCodeCliPath: () => '/tmp/coro-fake-cli.js',
  ensureClaudeCodeCliExecutable: () => {},
}))

// Skip the real symlink work — we won't have a real intelligence dir.
vi.mock('../src/intelligence-symlink', () => ({
  ensureClaudeConfigSymlink: () => {},
}))

vi.mock('../src/mcp-reattach', () => ({
  reattachDynamicMcpServers: async () => ({
    setResult: { added: [], removed: [], errors: {} },
    finalStatus: 'connected',
    reconnected: true,
  }),
}))

import { tmpdir } from 'os'
import { join } from 'path'
import pino from 'pino'
import { createSdkMcpServer, RateLimitExceededError } from '@coro/plugin-sdk'
import { createAnthropicExecutor } from '../src/executor'
import type { AnthropicExecutorSettings, ClaudeAuthConfig } from '../src/types'

const silentLogger = pino({ level: 'silent' })

function makeSettings(): AnthropicExecutorSettings {
  return {
    bitbucket: {
      workspace: '',
      coderAccount: { username: '', appPassword: '' },
    },
  }
}

describe('AnthropicExecutor — rate-limit classification', () => {
  it('rethrows SDK 429 as RateLimitExceededError(provider=anthropic, retryAfterMs=45000)', async () => {
    currentScenario = { kind: 'http-429' }
    const auth: ClaudeAuthConfig = { method: 'apiKey', apiKey: 'sk-ant-test' } as ClaudeAuthConfig
    const ex = createAnthropicExecutor({ settings: makeSettings(), auth, logger: silentLogger })
    const coroServer = createSdkMcpServer({ name: 'coro', tools: [] })

    const cwd = join(tmpdir(), `coro-rate-limit-test-${Date.now()}`)

    let caught: unknown
    try {
      for await (const _ev of ex.executePhase({
        systemPrompt: 's',
        userPrompt: 'u',
        model: 'claude-sonnet-4-6',
        cwd,
        intelligenceDir: cwd,
        mcpServer: { kind: 'sdk-instance', id: 'coro', instance: coroServer },
        pluginMcpServers: {},
        hookPolicy: { allowedTools: null, writeRoots: [cwd] },
        sessionState: {},
        maxTurns: 3,
        signal: new AbortController().signal,
      })) {
        // drain
      }
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(RateLimitExceededError)
    const rle = caught as RateLimitExceededError
    expect(rle.provider).toBe('anthropic')
    expect(rle.info.kind).toBe('rate-limit')
    expect(rle.info.retryAfterMs).toBe(45_000)
    expect(rle.info.source).toBe('retry-after')
    expect(rle.cause).toBeDefined()
  })

  it('uses rate_limit_event.resetsAt as the authoritative wait when the subprocess throws afterwards', async () => {
    // 4 hours out — well above the runner-side 30-minute cap. The
    // executor must emit it verbatim via source=reset-header so the
    // runner honors it exactly (honorHintExactly).
    const fourHoursOut = Math.floor(Date.now() / 1000) + 4 * 60 * 60
    currentScenario = {
      kind: 'rate-limit-event',
      resetsAt: fourHoursOut,
      errorMessage: "Claude Code returned an error result: You've hit your limit · resets 7:30pm (Asia/Famagusta)",
    }
    const auth: ClaudeAuthConfig = { method: 'apiKey', apiKey: 'sk-ant-test' } as ClaudeAuthConfig
    const ex = createAnthropicExecutor({ settings: makeSettings(), auth, logger: silentLogger })
    const coroServer = createSdkMcpServer({ name: 'coro', tools: [] })
    const cwd = join(tmpdir(), `coro-rate-limit-test-${Date.now()}-event`)

    let caught: unknown
    try {
      for await (const _ev of ex.executePhase({
        systemPrompt: 's',
        userPrompt: 'u',
        model: 'claude-sonnet-4-6',
        cwd,
        intelligenceDir: cwd,
        mcpServer: { kind: 'sdk-instance', id: 'coro', instance: coroServer },
        pluginMcpServers: {},
        hookPolicy: { allowedTools: null, writeRoots: [cwd] },
        sessionState: {},
        maxTurns: 3,
        signal: new AbortController().signal,
      })) {
        // drain
      }
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(RateLimitExceededError)
    const rle = caught as RateLimitExceededError
    expect(rle.provider).toBe('anthropic')
    expect(rle.info.kind).toBe('rate-limit')
    expect(rle.info.source).toBe('reset-header')
    // ±5s slack for test scheduling jitter; expected ~4h in ms.
    const expectedMs = fourHoursOut * 1000 - Date.now()
    expect(Math.abs(rle.info.retryAfterMs - expectedMs)).toBeLessThan(5_000)
  })

  it('recognises a plain-Error subprocess rate-limit message as fallback when no event was captured', async () => {
    currentScenario = {
      kind: 'plain-message',
      errorMessage: "Claude Code returned an error result: You've hit your limit · resets 6:50pm (Asia/Famagusta)",
    }
    const auth: ClaudeAuthConfig = { method: 'apiKey', apiKey: 'sk-ant-test' } as ClaudeAuthConfig
    const ex = createAnthropicExecutor({ settings: makeSettings(), auth, logger: silentLogger })
    const coroServer = createSdkMcpServer({ name: 'coro', tools: [] })
    const cwd = join(tmpdir(), `coro-rate-limit-test-${Date.now()}-plain`)

    let caught: unknown
    try {
      for await (const _ev of ex.executePhase({
        systemPrompt: 's',
        userPrompt: 'u',
        model: 'claude-sonnet-4-6',
        cwd,
        intelligenceDir: cwd,
        mcpServer: { kind: 'sdk-instance', id: 'coro', instance: coroServer },
        pluginMcpServers: {},
        hookPolicy: { allowedTools: null, writeRoots: [cwd] },
        sessionState: {},
        maxTurns: 3,
        signal: new AbortController().signal,
      })) {
        // drain
      }
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(RateLimitExceededError)
    const rle = caught as RateLimitExceededError
    expect(rle.provider).toBe('anthropic')
    expect(rle.info.kind).toBe('rate-limit')
    expect(rle.info.source).toBe('fallback')
    // Falls back to the executor's FALLBACK_CLAUDE_CODE_RATE_LIMIT_MS (5 min).
    expect(rle.info.retryAfterMs).toBe(5 * 60 * 1000)
  })
})
