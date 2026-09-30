import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ChatRequest, ChatResult } from '@coro-ai/plugin-sdk'
import type { Settings } from '../../src/config/settings'
import type { PluginRegistry } from '../../src/plugins/registry'
import {
  createIntakeSubagentDispatcher,
  resolveIntakeSubagentModel,
  INTAKE_SUBAGENT_MAX_TOOL_ROUNDS,
} from '../../src/intake/subagents'
import { DELEGATE_INVESTIGATION_TOOL_NAME, INTAKE_SUBAGENT_TIMEOUT_MS } from '../../src/intake/tools'
import type { IntakeStreamEvent } from '../../src/intake/stream-events'

const usage = {
  inputTokens: 2,
  outputTokens: 1,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
}

const lookupTools = [{
  name: 'scm_read_file',
  description: 'Read a file.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}]

function settings(over: Partial<Settings['intake']> = {}, aliases: Settings['llm'] extends infer L ? L extends { aliases?: infer A } ? A : never : never = {}): Settings {
  return {
    intake: over,
    llm: { aliases },
  } as Settings
}

type Chat = (req: ChatRequest) => Promise<ChatResult>

function executor(chat: Chat, supports: (model: string) => boolean = () => false) {
  return {
    manifest: { id: 'anthropic' },
    supports,
    chat: vi.fn(chat),
  }
}

function ok(output: string, tokens = usage): ChatResult {
  return { output, usage: tokens, toolCalls: [] }
}

describe('resolveIntakeSubagentModel', () => {
  const parent = 'claude-parent'

  it('uses a supported override', () => {
    const ex = executor(async () => ok('x'), model => model === 'claude-custom' || model === parent)
    expect(resolveIntakeSubagentModel(ex, parent, settings({ subagentModel: 'claude-custom' }))).toBe('claude-custom')
  })

  it('uses the mini alias when it resolves to this provider', () => {
    const ex = executor(async () => ok('x'), model => model === 'claude-haiku')
    const resolved = resolveIntakeSubagentModel(ex, parent, settings({}, {
      'tier:mini': { provider: 'anthropic', model: 'claude-haiku' },
    }))
    expect(resolved).toBe('claude-haiku')
  })

  it('falls back to the parent when the mini alias belongs to another provider', () => {
    const ex = executor(async () => ok('x'), () => true)
    const resolved = resolveIntakeSubagentModel(ex, parent, settings({}, {
      'tier:mini': { provider: 'openai', model: 'gpt-mini' },
    }))
    expect(resolved).toBe(parent)
  })

  it('falls back to the parent when nothing resolves, and never sends the literal mini', () => {
    const seen: string[] = []
    const ex = executor(async () => ok('x'), model => {
      seen.push(model)
      return false
    })
    expect(resolveIntakeSubagentModel(ex, parent, settings())).toBe(parent)
    expect(seen).not.toContain('mini')
  })
})

describe('createIntakeSubagentDispatcher', () => {
  let workRoot: string

  beforeEach(() => {
    workRoot = mkdtempSync(join(tmpdir(), 'coro-subagents-'))
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function dispatcher(chat: Chat, opts: { supports?: (model: string) => boolean; intake?: Partial<Settings['intake']>; aliases?: Record<string, { provider: string; model: string }> } = {}) {
    const ex = executor(chat, opts.supports)
    return {
      ex,
      runner: createIntakeSubagentDispatcher({
        executor: ex,
        parentModel: 'claude-parent',
        settings: settings(opts.intake, opts.aliases),
        registry: { all: () => [] } as unknown as PluginRegistry,
        lookupTools,
        toolDeps: {},
        pluginMcpServers: {},
        workRoot,
        emit: () => {},
      }),
    }
  }

  it('runs tasks in parallel', async () => {
    let started = 0
    let release: () => void = () => {}
    const bothStarted = new Promise<void>(resolve => { release = resolve })
    const { runner } = dispatcher(async () => {
      started += 1
      if (started === 2) release()
      await bothStarted
      return ok('found')
    })
    const reports = await runner.delegate(['one', 'two'], new AbortController().signal)
    expect(reports.map(r => r.ok)).toEqual([true, true])
    expect(started).toBe(2)
  }, 2000)

  it('keeps a failed task from sinking the rest', async () => {
    const { runner } = dispatcher(async (req) => {
      if (req.messages[0]?.content === 'fail') throw new Error('boom')
      return ok('found it')
    })
    const reports = await runner.delegate(['fail', 'ok'], new AbortController().signal)
    expect(reports[0]).toMatchObject({ task: 'fail', ok: false, error: 'boom' })
    expect(reports[1]).toMatchObject({ task: 'ok', ok: true, output: 'found it' })
  })

  it('treats an empty subagent reply as a failure', async () => {
    const { runner } = dispatcher(async () => ok('   '))
    const reports = await runner.delegate(['look'], new AbortController().signal)
    expect(reports[0]).toMatchObject({ ok: false, error: 'The subagent returned an empty response.' })
  })

  it('gives subagents the lookup tools only, on a fresh session in their own directory', async () => {
    const seen: ChatRequest[] = []
    const { runner } = dispatcher(async (req) => {
      seen.push(req)
      return ok('notes')
    })
    await runner.delegate(['alpha', 'beta'], new AbortController().signal)
    expect(seen).toHaveLength(2)
    for (const req of seen) {
      expect(req.sessionState).toBeUndefined()
      expect(req.onText).toBeUndefined()
      expect(req.onThinking).toBeUndefined()
      expect(req.tools?.map(t => t.name)).toEqual(['scm_read_file'])
      expect(req.tools?.map(t => t.name)).not.toContain(DELEGATE_INVESTIGATION_TOOL_NAME)
      expect(req.maxToolRounds).toBe(INTAKE_SUBAGENT_MAX_TOOL_ROUNDS)
      expect(req.cwd?.startsWith(join(workRoot, 'subagents', 'subagent-'))).toBe(true)
    }
    expect(seen[0]?.cwd).not.toBe(seen[1]?.cwd)
  })

  it('aborts in-flight subagents when the parent signal aborts', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const { runner } = dispatcher(async (req) => {
      seen = req.signal
      return new Promise((_resolve, reject) => {
        req.signal.addEventListener('abort', () => reject(new Error('inner')), { once: true })
      })
    })
    const pending = runner.delegate(['look'], controller.signal)
    await Promise.resolve()
    controller.abort()
    const reports = await pending
    expect(reports[0]).toMatchObject({ ok: false, error: 'Aborted' })
    expect(seen?.aborted).toBe(true)
  })

  it('reports a timeout instead of hanging', async () => {
    vi.useFakeTimers()
    const { runner } = dispatcher(() => new Promise(() => {}))
    const pending = runner.delegate(['look'], new AbortController().signal)
    await vi.advanceTimersByTimeAsync(INTAKE_SUBAGENT_TIMEOUT_MS)
    const reports = await pending
    expect(reports[0]?.ok).toBe(false)
    expect(reports[0]?.error).toMatch(/timed out/)
  })

  it('refuses a second delegation while four subagents are in flight', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const { runner } = dispatcher(() => gate.then(() => ok('done')))
    const first = runner.delegate(['a', 'b', 'c', 'd'], new AbortController().signal)
    await expect(runner.delegate(['e'], new AbortController().signal)).rejects.toThrow(/still running/)
    release()
    await first
  })

  it('sums usage and forwards tool events with the subagent label', async () => {
    const events: IntakeStreamEvent[] = []
    const ex = executor(async (req) => {
      req.onToolStart?.({ name: 'scm_read_file', input: { path: 'a.ts' } })
      req.onToolEnd?.({
        name: 'scm_read_file',
        input: { path: 'a.ts' },
        output: 'code',
        durationMs: 3,
      })
      return {
        output: 'notes',
        usage,
        toolCalls: [{ name: 'scm_read_file', input: { path: 'a.ts' }, output: 'code', durationMs: 3 }],
      }
    })
    const runner = createIntakeSubagentDispatcher({
      executor: ex,
      parentModel: 'claude-parent',
      settings: settings(),
      registry: { all: () => [] } as unknown as PluginRegistry,
      lookupTools,
      toolDeps: {},
      pluginMcpServers: {},
      workRoot,
      emit: event => events.push(event),
    })
    await runner.delegate(['one', 'two'], new AbortController().signal)
    expect(runner.usage()).toMatchObject({ inputTokens: 4, outputTokens: 2 })
    expect(events.filter(e => e.type === 'tool_start').map(e => e.subagent)).toEqual(['Subagent 1', 'Subagent 2'])
    expect(events.find(e => e.type === 'tool_end')).toMatchObject({
      subagent: 'Subagent 1',
      summary: 'Read a.ts',
      ok: true,
    })
  })
})
