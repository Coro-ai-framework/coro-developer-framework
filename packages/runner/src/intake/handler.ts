import type { ChatRequest, ChatResult } from '@coro-ai/plugin-sdk'
import { createSdkMcpServer, emptyNormalizedUsage, RateLimitExceededError } from '@coro-ai/plugin-sdk'
import type { PhaseExecutionRequest } from '@coro-ai/plugin-sdk'
import type { Logger } from 'pino'
import pino from 'pino'
import type { PluginRegistry } from '../plugins/registry'
import type { Settings } from '../config/settings'
import type { StateBackend } from '../state/backend'
import { selectModel, collectUserMcpServers, listUserMcpServerCatalog } from '../jobs/runner'
import { resolveIntelligenceDir, resolveWorkingDir } from '../config/local-config'
import {
  buildIntakeTools,
  createIntakeRunTool,
  DELEGATE_INVESTIGATION_TOOL,
  INTAKE_MAX_TOOL_ROUNDS,
  REQUEST_TOOL_ACCESS_TOOL,
} from './tools'
import { buildWorkspaceChatTools, createWorkspaceTools } from '../tools/workspace-tools'
import {
  createIntakePermissionBroker,
  INTAKE_PERMISSION_TIMEOUT_MS,
  readIntakePermissionConfig,
  resolveToolAccess,
} from './permissions'
import { createIntakeSubagentDispatcher, intakeSubagentsEnabled } from './subagents'
import {
  createIntakeEventQueue,
  toolEndEvent,
  toolStartEvent,
  type IntakeEventQueue,
  type IntakeStreamEvent,
} from './stream-events'
import {
  buildIntakeSystemPrompt,
  formatIntakeUserPrompt,
  renderDispatchedRunBlock,
  type IntakeContext,
  type IntakeMessage,
} from './system-prompt'
import { resolveDispatchedRunId } from './past-jobs'
import {
  buildIntakeMessages,
  endIntakeTurn,
  getIntakeSession,
  recordIntakeTurn,
  renderIntakeEvidence,
  reconcileIntakeSession,
  tryBeginIntakeTurn,
  bindIntakeExecutor,
  persistIntakeExecutorSession,
  ensureIntakeWorkRoot,
  resetIntakeSessionsForTests,
  updateIntakeToolAccess,
  type IntakeEvidence,
} from './session-store'
import { persistLiveIntakeSession } from './persist'

export { resetIntakeSessionsForTests }
export type { IntakeStreamEvent } from './stream-events'

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
  /** When set, successful turns are upserted to the investigations table. */
  stateBackend?: StateBackend
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

async function persistTurn(options: RunIntakeOptions): Promise<void> {
  if (!options.stateBackend) return
  try {
    await persistLiveIntakeSession(options.stateBackend, options.sessionId, {
      modelChoice: {
        provider: options.provider ?? '',
        model: options.model ?? '',
      },
    })
  } catch (err) {
    options.logger?.warn(
      { err, sessionId: options.sessionId },
      'intake: failed to persist investigation',
    )
  }
}

/**
 * Wraps `executor.chat()` so the runner can stream live SSE frames as
 * the model thinks, speaks, and invokes tools. The executor itself
 * only resolves a single final `ChatResult`; we bridge to a stream by
 * attaching `onText` / `onThinking` / `onToolStart` / `onToolEnd`
 * hooks that push events into a shared queue. Nested subagent hooks
 * push into the same queue, so their tool frames interleave live.
 *
 * Invariants:
 *   - The hooks fire synchronously inside the executor's tool loop,
 *     so each push happens-before the corresponding wake.
 *   - When the chat task resolves/rejects, the awaited wait unblocks
 *     and we drain any remaining queued events before returning the
 *     final ChatResult (or throwing).
 */
async function* streamChatTurn(
  executor: { chat: (req: ChatRequest) => Promise<ChatResult> },
  chatReq: ChatRequest,
  events: IntakeEventQueue,
): AsyncGenerator<IntakeStreamEvent, { result: ChatResult; streamedText: boolean }> {
  let streamedText = false

  const reqWithHooks: ChatRequest = {
    ...chatReq,
    onText: content => {
      if (!content) return
      streamedText = true
      chatReq.onText?.(content)
      events.push({ type: 'token', text: content })
    },
    onThinking: content => {
      if (!content) return
      chatReq.onThinking?.(content)
      events.push({ type: 'thinking', text: content })
    },
    onToolStart: info => {
      chatReq.onToolStart?.(info)
      events.push(toolStartEvent(info))
    },
    onToolEnd: record => {
      chatReq.onToolEnd?.(record)
      events.push(toolEndEvent(record))
    },
  }

  let done: ChatResult | null = null
  let chatError: unknown = null
  let settled = false
  const chatTask = executor.chat(reqWithHooks)
    .then(result => { done = result }, err => { chatError = err })
    .finally(() => { settled = true })

  while (!settled) {
    yield* events.drain()
    await events.until(chatTask)
  }
  yield* events.drain()

  if (chatError) throw chatError
  return { result: done!, streamedText }
}

const TURN_IN_PROGRESS_MESSAGE =
  'This conversation is still investigating your last message. It will show up here when that finishes.'

export async function* runIntakeStream(options: RunIntakeOptions): AsyncGenerator<IntakeStreamEvent> {
  const userMessage = typeof options.message === 'string' ? options.message.trim() : ''
  if (!userMessage) {
    yield {
      type: 'error',
      message: 'Plan mode did not receive a user message. Try sending again.',
    }
    return
  }

  // One turn per session. A second message — the "continue" someone sends
  // after a refresh, while subagents are still running — must not reconcile
  // a transcript that has none of their evidence. That is what made the
  // model start the investigation over.
  if (!tryBeginIntakeTurn(options.sessionId)) {
    yield { type: 'error', message: TURN_IN_PROGRESS_MESSAGE, reason: 'turn-in-progress' }
    return
  }
  try {
    yield* executeIntakeTurn(options, userMessage)
  } finally {
    endIntakeTurn(options.sessionId)
  }
}

async function* executeIntakeTurn(
  options: RunIntakeOptions,
  userMessage: string,
): AsyncGenerator<IntakeStreamEvent> {
  const baseLogger = options.logger ?? pino({ level: 'silent' })
  const log = baseLogger.child({ component: 'intake-handler', sessionId: options.sessionId })
  const toolsOn = intakeToolsEnabled(options.settings)

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
      yield { type: 'error', message: 'Coro plan mode needs an LLM provider. Configure one in Settings.', reason: 'no-llm' }
      return
    }
    yield { type: 'error', message }
    return
  }

  bindIntakeExecutor(options.sessionId, executor.manifest?.id)
  const liveSession = getIntakeSession(options.sessionId)
  const workRoot = ensureIntakeWorkRoot(options.sessionId)
  const model = assignment.model
  const cwd = resolveWorkingDir(null)
  const intelligenceDir = resolveIntelligenceDir(null)
  const events = createIntakeEventQueue()
  const mcpCatalog = toolsOn ? listUserMcpServerCatalog({ logger: baseLogger }) : []
  const permissionConfig = toolsOn ? readIntakePermissionConfig(baseLogger) : null
  const currentAccess = () => resolveToolAccess(
    getIntakeSession(options.sessionId).toolAccess,
    permissionConfig!,
    mcpCatalog,
  )
  const accessAtStart = toolsOn ? currentAccess() : null
  const nativeFiles = executor.capabilities?.supportsNativeFileTools === true
  const nativeWeb = executor.capabilities?.supportsNativeWebTools === true
  const planModeMcpServers = toolsOn
    ? collectUserMcpServers({
        logger: baseLogger,
        filter: id => accessAtStart!.mcp[id] !== 'off',
      })
    : {}
  const planModeMcpServerIds = Object.keys(planModeMcpServers)
  const broker = toolsOn
    ? createIntakePermissionBroker({
        sessionId: options.sessionId,
        workRoot,
        attachedMcpIds: new Set(planModeMcpServerIds),
        emit: events.push,
        signal: options.signal,
        getAccess: currentAccess,
        updateSessionAccess: fn => {
          updateIntakeToolAccess(options.sessionId, fn)
          void persistTurn(options)
        },
        logger: log,
      })
    : undefined
  const workspace = toolsOn && (!nativeFiles || !nativeWeb)
    ? createWorkspaceTools({ root: workRoot })
    : undefined
  const accessTools = toolsOn
    ? buildWorkspaceChatTools({ includeFiles: !nativeFiles, includeWeb: !nativeWeb })
    : []
  const lookupTools = toolsOn
    ? [...buildIntakeTools(options.registry, { stateBackend: options.stateBackend }), ...accessTools]
    : []
  const subagents =
    toolsOn &&
    intakeSubagentsEnabled(options.settings) &&
    typeof executor.chat === 'function' &&
    (lookupTools.length > 0 || planModeMcpServerIds.length > 0)
      ? createIntakeSubagentDispatcher({
          executor: executor as Parameters<typeof createIntakeSubagentDispatcher>[0]['executor'],
          parentModel: model,
          settings: options.settings,
          registry: options.registry,
          lookupTools,
          toolDeps: { stateBackend: options.stateBackend, workingDir: cwd },
          pluginMcpServers: planModeMcpServers,
          workRoot,
          emit: events.push,
          logger: log,
          ...(broker ? { permissionGate: (name, input) => broker.gate(name, input, { canAsk: false }) } : {}),
          ...(workspace ? { workspace } : {}),
          nativeTools: nativeFiles,
        })
      : undefined
  const tools = [
    ...lookupTools,
    ...(toolsOn ? [REQUEST_TOOL_ACCESS_TOOL] : []),
    ...(subagents ? [DELEGATE_INVESTIGATION_TOOL] : []),
  ]
  const hasTools = tools.length > 0 || planModeMcpServerIds.length > 0
  const pastJobsEnabled = tools.some(t => t.name === 'list_past_jobs')

  log?.debug(
    {
      pluginId: executor.manifest?.id,
      assignment,
      hasChat: typeof executor.chat === 'function',
      hasRunSubagent: typeof executor.runSubagent === 'function',
      toolsOn,
      subagents: Boolean(subagents),
    },
    'intake: executor resolved',
  )

  const systemPrompt = buildIntakeSystemPrompt(options.context, {
    toolsEnabled: hasTools,
    pastJobsEnabled,
    planModeMcpServerIds,
    subagentsEnabled: Boolean(subagents),
    ...(accessAtStart
      ? {
          access: {
            modes: accessAtStart.capabilities,
            nativeFiles,
            nativeWeb,
            scratchDir: workRoot,
            mcpAttached: planModeMcpServerIds,
            mcpOnRequest: mcpCatalog.filter(entry => accessAtStart.mcp[entry.id] === 'off').map(entry => entry.id),
          },
        }
      : {}),
  })

  // A dispatched run is only worth naming when the agent also has the tools
  // to open it, so this rides on `pastJobsEnabled` rather than a second
  // condition that could drift from it. Like plan-mode findings on the job
  // side, it is an enhancement: a missing row or a backend hiccup must not
  // cost the developer their turn.
  let dispatchedRunId: string | null = null
  if (pastJobsEnabled && options.stateBackend) {
    try {
      dispatchedRunId = await resolveDispatchedRunId(options.sessionId, {
        stateBackend: options.stateBackend,
      })
    } catch (err) {
      log?.warn({ err }, 'intake: could not resolve this investigation’s dispatched run')
    }
  }

  // Recorded turns keep the developer's raw text (see `recordIntakeTurn`
  // below), so the block is re-derived per turn and never replayed stale
  // out of the transcript.
  const conversation = buildIntakeMessages(
    session,
    dispatchedRunId
      ? `${renderDispatchedRunBlock(dispatchedRunId)}\n\n${userMessage}`
      : userMessage,
  )
  const emptyMcp = createSdkMcpServer({ name: 'coro', tools: [] })
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
        ...(broker
          ? {
              permissionGate: (name: string, input: unknown) => broker.gate(name, input),
              permissionTimeoutMs: INTAKE_PERMISSION_TIMEOUT_MS,
            }
          : {}),
        ...(toolsOn && nativeFiles ? { nativeTools: true } : {}),
        ...(tools.length > 0
          ? {
              tools,
              maxToolRounds: INTAKE_MAX_TOOL_ROUNDS,
              runTool: createIntakeRunTool(options.registry, options.signal, {
                stateBackend: options.stateBackend,
                workingDir: cwd,
                ...(subagents ? { subagents } : {}),
                ...(workspace ? { workspace } : {}),
                ...(broker
                  ? {
                      gate: (name, input) => broker.gate(name, input),
                      requestCapability: (capability, reason) => broker.requestCapability(capability, reason),
                    }
                  : {}),
              }),
            }
          : {}),
      }

      let result: ChatResult
      let streamedText = false
      const chatGen = streamChatTurn(
        executor as { chat: (req: ChatRequest) => Promise<ChatResult> },
        chatReq,
        events,
      )
      let next = await chatGen.next()
      while (!next.done) {
        if (next.value.type === 'token') streamedText = true
        yield next.value
        next = await chatGen.next()
      }
      result = next.value.result
      streamedText = streamedText || next.value.streamedText

      const subagentUsage = subagents?.usage() ?? emptyNormalizedUsage()
      const subagentTokens = subagentUsage.inputTokens + subagentUsage.outputTokens
      const tokens = result.usage.inputTokens + result.usage.outputTokens

      log?.debug(
        {
          pluginId: executor.manifest?.id,
          elapsedMs: Date.now() - startedAt,
          outputChars: result.output.length,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          toolCalls: result.toolCalls?.length ?? 0,
          subagentTokens,
        },
        'intake: chat() resolved',
      )

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
        extraBilledTokens: subagentTokens,
      })
      persistIntakeExecutorSession(options.sessionId, result.sessionState)
      await persistTurn(options)

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
          inputTokens: result.usage.inputTokens + subagentUsage.inputTokens,
          outputTokens: result.usage.outputTokens + subagentUsage.outputTokens,
          totalTokens: tokens + subagentTokens,
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
      await persistTurn(options)

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
    await persistTurn(options)

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
  } finally {
    broker?.dispose('turn ended')
  }
}
