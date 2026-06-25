import type { ChatRequest, ChatResult } from '@coro-ai/plugin-sdk'
import { chatHasTools } from '@coro-ai/plugin-sdk'
import { createSdkMcpServer } from '@coro-ai/plugin-sdk'
import type { PhaseExecutionRequest } from '@coro-ai/plugin-sdk'
import type { Logger } from 'pino'
import pino from 'pino'
import type { PluginRegistry } from '../plugins/registry'
import type { Settings } from '../config/settings'
import { selectModel, collectPlanModeMcpServers } from '../jobs/runner'
import { resolveIntelligenceDir, resolveWorkingDir } from '../config/local-config'
import {
  buildIntakeTools,
  createIntakeRunTool,
  INTAKE_MAX_TOOL_ROUNDS,
  summarizeToolCall,
} from './tools'
import {
  buildIntakeSystemPrompt,
  formatIntakeUserPrompt,
  type IntakeContext,
  type IntakeMessage,
} from './system-prompt'

const MAX_TURNS_PER_SESSION = 8
const MAX_TOKENS_PER_SESSION = 30_000
const MAX_TOKENS_PER_SESSION_WITH_TOOLS = 60_000

interface SessionBudget {
  turns: number
  tokens: number
}

const sessionBudgets = new Map<string, SessionBudget>()

export interface IntakeStreamEvent {
  type: 'token' | 'done' | 'error' | 'tool_start' | 'tool_end'
  text?: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  message?: string
  name?: string
  input?: unknown
  durationMs?: number
  ok?: boolean
  summary?: string
  error?: string
}

export interface RunIntakeOptions {
  sessionId: string
  messages: IntakeMessage[]
  context: IntakeContext
  registry: PluginRegistry
  settings: Settings
  signal: AbortSignal
  model?: string
  provider?: string
  logger?: Logger
}

function resolveIntakeAssignment(options: RunIntakeOptions): { model: string; provider?: string } {
  const explicitModel = options.model?.trim()
  if (explicitModel) {
    return {
      model: explicitModel,
      ...(options.provider?.trim() ? { provider: options.provider.trim() } : {}),
    }
  }
  return { model: selectModel({ tier: 'planning' }, options.settings) }
}

function getBudget(sessionId: string): SessionBudget {
  const existing = sessionBudgets.get(sessionId)
  if (existing) return existing
  const fresh = { turns: 0, tokens: 0 }
  sessionBudgets.set(sessionId, fresh)
  return fresh
}

function intakeToolsEnabled(settings: Settings): boolean {
  return settings.intake?.toolsEnabled !== false
}

/**
 * Wraps `executor.chat()` so the runner can stream `tool_start` /
 * `tool_end` SSE frames as the model invokes tools. The executor
 * itself only emits a single final `ChatResult`; we bridge to a
 * stream by attaching `onToolStart` / `onToolEnd` hooks that push
 * events into a queue and wake the generator loop via `notify`.
 *
 * Invariants:
 *   - The hooks fire synchronously inside the executor's tool loop,
 *     so each push happens-before the corresponding `notify?.()`.
 *   - When the chat task resolves/rejects, the awaited `Promise.race`
 *     unblocks and we drain any remaining queued events before
 *     returning the final ChatResult (or throwing).
 *   - Caller must only invoke this with `chatReq.tools?.length > 0`
 *     (no-tools is a single awaited call; no streaming needed).
 */
async function* streamChatTurn(
  executor: { chat: (req: ChatRequest) => Promise<ChatResult> },
  chatReq: ChatRequest,
): AsyncGenerator<IntakeStreamEvent, ChatResult> {
  let notify: (() => void) | null = null
  const queue: IntakeStreamEvent[] = []

  const reqWithHooks: ChatRequest = {
    ...chatReq,
    onToolStart: info => {
      queue.push({ type: 'tool_start', name: info.name, input: info.input })
      notify?.()
      notify = null
    },
    onToolEnd: record => {
      queue.push({
        type: 'tool_end',
        name: record.name,
        durationMs: record.durationMs,
        ok: !record.error,
        summary: record.error ?? summarizeToolCall(record.name, record.input, record.output),
        ...(record.error ? { error: record.error } : {}),
      })
      notify?.()
      notify = null
    },
  }

  let done: ChatResult | null = null
  let chatError: unknown = null
  const chatTask = executor.chat(reqWithHooks)
    .then(result => { done = result })
    .catch(err => { chatError = err })

  while (!done && !chatError) {
    while (queue.length > 0) {
      yield queue.shift()!
    }
    await Promise.race([
      chatTask,
      new Promise<void>(resolve => { notify = resolve }),
    ])
  }

  while (queue.length > 0) {
    yield queue.shift()!
  }

  if (chatError) throw chatError
  return done!
}

export async function* runIntakeStream(options: RunIntakeOptions): AsyncGenerator<IntakeStreamEvent> {
  const baseLogger = options.logger ?? pino({ level: 'silent' })
  const log = baseLogger.child({ component: 'intake-handler', sessionId: options.sessionId })
  const budget = getBudget(options.sessionId)
  const toolsOn = intakeToolsEnabled(options.settings)
  const tokenCap = toolsOn ? MAX_TOKENS_PER_SESSION_WITH_TOOLS : MAX_TOKENS_PER_SESSION

  log?.debug(
    {
      sessionTurns: budget.turns,
      sessionTokens: budget.tokens,
      messageCount: options.messages.length,
      overrideModel: options.model ?? null,
      overrideProvider: options.provider ?? null,
      toolsOn,
      signalAbortedAtEntry: options.signal.aborted,
    },
    'intake: stream invoked',
  )

  if (budget.turns >= MAX_TURNS_PER_SESSION) {
    yield {
      type: 'error',
      message: 'Session turn limit reached. Please review the brief or switch to the form.',
    }
    return
  }
  if (budget.tokens >= tokenCap) {
    yield {
      type: 'error',
      message: 'Session token budget exhausted. Please review the brief or switch to the form.',
    }
    return
  }

  budget.turns += 1

  const assignment = resolveIntakeAssignment(options)

  let executor
  try {
    executor = options.registry.resolveExecutor({
      model: assignment.model,
      ...(assignment.provider ? { provider: assignment.provider } : {}),
    })
  } catch (err) {
    const message = (err as Error).message
    log?.warn({ err, assignment }, 'intake: resolveExecutor failed')
    if (/executor|provider|llm/i.test(message)) {
      yield { type: 'error', message: 'Coro plan mode needs an LLM provider. Configure one in Settings.', reason: 'no-llm' } as IntakeStreamEvent & { reason?: string }
      return
    }
    yield { type: 'error', message }
    return
  }

  log?.debug(
    {
      pluginId: executor.manifest?.id,
      assignment,
      hasChat: typeof executor.chat === 'function',
      hasRunSubagent: typeof executor.runSubagent === 'function',
      toolsOn,
    },
    'intake: executor resolved',
  )

  const tools = toolsOn ? buildIntakeTools(options.registry) : []
  const planModeMcpServers = toolsOn ? collectPlanModeMcpServers({ logger: baseLogger }) : {}
  const planModeMcpServerIds = Object.keys(planModeMcpServers)
  const hasTools = tools.length > 0 || planModeMcpServerIds.length > 0
  const systemPrompt = buildIntakeSystemPrompt(options.context, {
    toolsEnabled: hasTools,
    planModeMcpServerIds,
  })
  const cwd = resolveWorkingDir(null)
  const intelligenceDir = resolveIntelligenceDir(null)
  const emptyMcp = createSdkMcpServer({ name: 'coro', tools: [] })
  const model = assignment.model
  const hookPolicy = { allowedTools: [] as string[], writeRoots: [] as string[] }

  try {
    if (typeof executor.chat === 'function') {
      log?.debug(
        {
          pluginId: executor.manifest?.id,
          model,
          toolCount: tools.length,
          planModeMcpCount: planModeMcpServerIds.length,
        },
        'intake: invoking executor.chat()',
      )
      const startedAt = Date.now()

      const chatReq: ChatRequest = {
        messages: options.messages.map(m => ({ role: m.role, content: m.content })),
        systemPrompt,
        model,
        signal: options.signal,
        ...(Object.keys(planModeMcpServers).length > 0 ? { pluginMcpServers: planModeMcpServers } : {}),
        ...(tools.length > 0
          ? {
              tools,
              maxToolRounds: INTAKE_MAX_TOOL_ROUNDS,
              runTool: createIntakeRunTool(options.registry, options.signal),
            }
          : {}),
      }

      let result: ChatResult
      if (chatHasTools(chatReq)) {
        const chatGen = streamChatTurn(
          executor as { chat: (req: ChatRequest) => Promise<ChatResult> },
          chatReq,
        )
        let next = await chatGen.next()
        while (!next.done) {
          yield next.value
          next = await chatGen.next()
        }
        result = next.value
      } else {
        result = await executor.chat(chatReq)
      }

      log?.debug(
        {
          pluginId: executor.manifest?.id,
          elapsedMs: Date.now() - startedAt,
          outputChars: result.output.length,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          toolCalls: result.toolCalls?.length ?? 0,
        },
        'intake: chat() resolved',
      )

      const tokens = result.usage.inputTokens + result.usage.outputTokens
      budget.tokens += tokens

      const trimmed = result.output.trim()
      if (!trimmed) {
        yield {
          type: 'error',
          message: 'The model returned an empty response. Try again, or switch models from the picker below.',
        }
        return
      }

      const chunks = trimmed.match(/.{1,24}/g) ?? [trimmed]
      for (const chunk of chunks) {
        yield { type: 'token', text: chunk }
      }
      yield {
        type: 'done',
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: tokens,
        },
      }
      return
    }

    const userPrompt = formatIntakeUserPrompt(options.messages)
    if (typeof executor.runSubagent === 'function') {
      const result = await executor.runSubagent({
        name: 'intake',
        task: userPrompt,
        systemPrompt,
        model,
        cwd,
        intelligenceDir,
        mcpServer: { kind: 'sdk-instance', id: 'coro', instance: emptyMcp },
        pluginMcpServers: planModeMcpServers,
        hookPolicy,
        allowedTools: [],
        maxTurns: 1,
        signal: options.signal,
      })

      const tokens = result.usage.inputTokens + result.usage.outputTokens
      budget.tokens += tokens

      const chunks = result.output.match(/.{1,24}/g) ?? [result.output]
      for (const chunk of chunks) {
        yield { type: 'token', text: chunk }
      }
      yield {
        type: 'done',
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: tokens,
        },
      }
      return
    }

    const req: PhaseExecutionRequest = {
      systemPrompt,
      userPrompt,
      model,
      cwd,
      intelligenceDir,
      mcpServer: { kind: 'sdk-instance', id: 'coro', instance: emptyMcp },
      pluginMcpServers: planModeMcpServers,
      hookPolicy,
      sessionState: { conversationHistory: [] },
      maxTurns: 1,
      phase: 'intake',
      signal: options.signal,
    }

    let inputTokens = 0
    let outputTokens = 0

    for await (const event of executor.executePhase(req)) {
      if (event.type === 'text' && event.content) {
        yield { type: 'token', text: event.content }
      } else if (event.type === 'usage') {
        inputTokens = event.tokens.inputTokens
        outputTokens = event.tokens.outputTokens
      }
    }

    const totalTokens = inputTokens + outputTokens
    budget.tokens += totalTokens

    yield {
      type: 'done',
      usage: { inputTokens, outputTokens, totalTokens },
    }
  } catch (err) {
    log?.error(
      {
        err,
        errName: (err as { name?: string }).name,
        errMessage: (err as { message?: string }).message,
        signalAborted: options.signal.aborted,
      },
      'intake: stream threw',
    )
    yield { type: 'error', message: (err as Error).message }
  }
}

export function resetIntakeSessionBudgetsForTests(): void {
  sessionBudgets.clear()
}
