import type { ChatRequest, ChatResult } from '@coro-ai/plugin-sdk'
import { createSdkMcpServer, RateLimitExceededError } from '@coro-ai/plugin-sdk'
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
import {
  buildIntakeMessages,
  getIntakeSession,
  recordIntakeTurn,
  renderIntakeEvidence,
  reconcileIntakeSession,
  bindIntakeExecutor,
  persistIntakeExecutorSession,
  ensureIntakeWorkRoot,
  resetIntakeSessionsForTests,
  type IntakeEvidence,
} from './session-store'

export { resetIntakeSessionsForTests }

export interface IntakeStreamEvent {
  type: 'token' | 'thinking' | 'done' | 'error' | 'tool_start' | 'tool_end'
  text?: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  /** Tokens resident in the model's context after this turn. */
  contextTokens?: number
  /** Cumulative billed tokens across the whole session. */
  sessionTokens?: number
  /** Completed turns in this session, including this one. */
  turns?: number
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
  /** The new developer message. Prior turns live in the server-side session. */
  message: string
  /**
   * Transcript from the browser. Seeds an empty session (runner restart)
   * and fills in turns the server never recorded (rate-limit, empty
   * output, abort). Ignored when it matches what the runner already has.
   */
  seedMessages?: IntakeMessage[]
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

function intakeToolsEnabled(settings: Settings): boolean {
  return settings.intake?.toolsEnabled !== false
}

/**
 * An investigative turn reports findings, lists open questions, and may carry
 * a full run payload — well past the executors' 1–2k defaults, which would
 * truncate mid-JSON and leave the dashboard with nothing to parse.
 */
const INTAKE_MAX_OUTPUT_TOKENS = 4096

/**
 * Splits into fixed-width pieces for the token stream. Deliberately not a
 * `/.{1,24}/g` match: `.` does not match newlines, so a regex chunker
 * silently strips every line break out of a multi-paragraph finding.
 */
function chunkForStream(text: string, size = 24): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
  return chunks
}

function describeIntakeChatError(err: unknown): string {
  if (err instanceof RateLimitExceededError) {
    const waitSec = Math.max(1, Math.round(err.info.retryAfterMs / 1000))
    const kind = err.info.kind === 'overloaded' ? 'capacity limit' : 'rate limit'
    return `The model hit a ${kind}. Wait about ${waitSec}s and send again — this conversation is still open.`
  }
  return err instanceof Error ? err.message : String(err)
}

/**
 * Wraps `executor.chat()` so the runner can stream live SSE frames as
 * the model thinks, speaks, and invokes tools. The executor itself
 * only resolves a single final `ChatResult`; we bridge to a stream by
 * attaching `onText` / `onThinking` / `onToolStart` / `onToolEnd`
 * hooks that push events into a queue and wake the generator loop via
 * `notify`.
 *
 * Invariants:
 *   - The hooks fire synchronously inside the executor's tool loop,
 *     so each push happens-before the corresponding `notify?.()`.
 *   - When the chat task resolves/rejects, the awaited `Promise.race`
 *     unblocks and we drain any remaining queued events before
 *     returning the final ChatResult (or throwing).
 */
async function* streamChatTurn(
  executor: { chat: (req: ChatRequest) => Promise<ChatResult> },
  chatReq: ChatRequest,
): AsyncGenerator<IntakeStreamEvent, { result: ChatResult; streamedText: boolean }> {
  let notify: (() => void) | null = null
  const queue: IntakeStreamEvent[] = []
  let streamedText = false

  const wake = (): void => {
    notify?.()
    notify = null
  }

  const reqWithHooks: ChatRequest = {
    ...chatReq,
    onText: content => {
      if (!content) return
      streamedText = true
      chatReq.onText?.(content)
      queue.push({ type: 'token', text: content })
      wake()
    },
    onThinking: content => {
      if (!content) return
      chatReq.onThinking?.(content)
      queue.push({ type: 'thinking', text: content })
      wake()
    },
    onToolStart: info => {
      chatReq.onToolStart?.(info)
      queue.push({ type: 'tool_start', name: info.name, input: info.input })
      wake()
    },
    onToolEnd: record => {
      chatReq.onToolEnd?.(record)
      queue.push({
        type: 'tool_end',
        name: record.name,
        durationMs: record.durationMs,
        ok: !record.error,
        summary: record.error ?? summarizeToolCall(record.name, record.input, record.output),
        ...(record.error ? { error: record.error } : {}),
      })
      wake()
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
  return { result: done!, streamedText }
}

export async function* runIntakeStream(options: RunIntakeOptions): AsyncGenerator<IntakeStreamEvent> {
  const baseLogger = options.logger ?? pino({ level: 'silent' })
  const log = baseLogger.child({ component: 'intake-handler', sessionId: options.sessionId })
  const toolsOn = intakeToolsEnabled(options.settings)

  const userMessage = typeof options.message === 'string' ? options.message.trim() : ''
  if (!userMessage) {
    yield {
      type: 'error',
      message: 'Plan mode did not receive a user message. Try sending again.',
    }
    return
  }

  const session = options.seedMessages?.length
    ? reconcileIntakeSession(options.sessionId, options.seedMessages)
    : getIntakeSession(options.sessionId)

  // Plan mode is deliberately uncapped: every turn is developer-initiated,
  // so there is no autonomous loop for a turn or token ceiling to protect
  // against — and an investigation is exactly the session a ceiling would
  // kill halfway. The only unattended spend is the per-turn tool loop,
  // bounded by INTAKE_MAX_TOOL_ROUNDS. Counters below are reported to the
  // dashboard for visibility, never enforced.
  log?.debug(
    {
      sessionTurns: session.turns.length,
      sessionTokens: session.tokens,
      contextTokens: session.contextTokens,
      overrideModel: options.model ?? null,
      overrideProvider: options.provider ?? null,
      toolsOn,
      signalAbortedAtEntry: options.signal.aborted,
    },
    'intake: stream invoked',
  )

  const conversation = buildIntakeMessages(session, userMessage)
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

  bindIntakeExecutor(options.sessionId, executor.manifest?.id)
  const liveSession = getIntakeSession(options.sessionId)
  const workRoot = ensureIntakeWorkRoot(options.sessionId)

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
        messages: conversation,
        systemPrompt,
        model,
        maxOutputTokens: INTAKE_MAX_OUTPUT_TOKENS,
        signal: options.signal,
        cwd: workRoot,
        ...(liveSession.executorSession ? { sessionState: liveSession.executorSession } : {}),
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
      let streamedText = false
      const chatGen = streamChatTurn(
        executor as { chat: (req: ChatRequest) => Promise<ChatResult> },
        chatReq,
      )
      let next = await chatGen.next()
      while (!next.done) {
        if (next.value.type === 'token') streamedText = true
        yield next.value
        next = await chatGen.next()
      }
      result = next.value.result
      streamedText = streamedText || next.value.streamedText

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

      const trimmed = result.output.trim()
      if (!trimmed) {
        yield {
          type: 'error',
          message: 'The model returned an empty response. Try again, or switch models from the picker below.',
        }
        return
      }

      const evidence: IntakeEvidence[] = (result.toolCalls ?? []).map(call =>
        renderIntakeEvidence({
          name: call.name,
          input: call.input,
          output: call.output,
          ...(call.error ? { error: call.error } : {}),
        }),
      )
      const updated = recordIntakeTurn(options.sessionId, {
        user: userMessage,
        assistant: trimmed,
        evidence,
        usage: result.usage,
      })
      persistIntakeExecutorSession(options.sessionId, result.sessionState)

      // Live onText already streamed the reply. A plugin that never
      // called the hook still needs the dump so the dashboard is not
      // left with an empty bubble.
      if (!streamedText) {
        for (const chunk of chunkForStream(trimmed)) {
          yield { type: 'token', text: chunk }
        }
      }
      yield {
        type: 'done',
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: tokens,
        },
        contextTokens: updated.contextTokens,
        sessionTokens: updated.tokens,
        turns: updated.turns.length,
      }
      return
    }

    const userPrompt = formatIntakeUserPrompt(conversation)
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
      const updated = recordIntakeTurn(options.sessionId, {
        user: userMessage,
        assistant: result.output.trim(),
        evidence: [],
        usage: result.usage,
      })

      for (const chunk of chunkForStream(result.output)) {
        yield { type: 'token', text: chunk }
      }
      yield {
        type: 'done',
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: tokens,
        },
        contextTokens: updated.contextTokens,
        sessionTokens: updated.tokens,
        turns: updated.turns.length,
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
      sessionState: liveSession.executorSession ?? { conversationHistory: [] },
      maxTurns: 1,
      phase: 'intake',
      signal: options.signal,
    }

    let inputTokens = 0
    let outputTokens = 0
    let assistantText = ''

    for await (const event of executor.executePhase(req)) {
      if (event.type === 'text' && event.content) {
        assistantText += event.content
        yield { type: 'token', text: event.content }
      } else if (event.type === 'thinking' && event.content) {
        yield { type: 'thinking', text: event.content }
      } else if (event.type === 'usage') {
        inputTokens = event.tokens.inputTokens
        outputTokens = event.tokens.outputTokens
      }
    }

    const totalTokens = inputTokens + outputTokens
    const updated = recordIntakeTurn(options.sessionId, {
      user: userMessage,
      assistant: assistantText.trim(),
      evidence: [],
      usage: { inputTokens, outputTokens },
    })

    yield {
      type: 'done',
      usage: { inputTokens, outputTokens, totalTokens },
      contextTokens: updated.contextTokens,
      sessionTokens: updated.tokens,
      turns: updated.turns.length,
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
    yield { type: 'error', message: describeIntakeChatError(err) }
  }
}
