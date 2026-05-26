import { createSdkMcpServer } from '@coro-ai/plugin-sdk'
import type { PhaseExecutionRequest } from '@coro-ai/plugin-sdk'
import type { Logger } from 'pino'
import type { PluginRegistry } from '../plugins/registry'
import type { Settings } from '../config/settings'
import { selectModel } from '../jobs/runner'
import { resolveIntelligenceDir, resolveWorkingDir } from '../config/local-config'
import {
  buildIntakeSystemPrompt,
  formatIntakeUserPrompt,
  type IntakeContext,
  type IntakeMessage,
} from './system-prompt'

const MAX_TURNS_PER_SESSION = 8
const MAX_TOKENS_PER_TURN = 4_000
const MAX_TOKENS_PER_SESSION = 30_000

interface SessionBudget {
  turns: number
  tokens: number
}

const sessionBudgets = new Map<string, SessionBudget>()

export interface IntakeStreamEvent {
  type: 'token' | 'done' | 'error'
  text?: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  message?: string
}

export interface RunIntakeOptions {
  sessionId: string
  messages: IntakeMessage[]
  context: IntakeContext
  registry: PluginRegistry
  settings: Settings
  signal: AbortSignal
  /** Optional per-session override from the dashboard model picker. */
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

export async function* runIntakeStream(options: RunIntakeOptions): AsyncGenerator<IntakeStreamEvent> {
  const log = options.logger?.child({ component: 'intake-handler', sessionId: options.sessionId })
  const budget = getBudget(options.sessionId)

  log?.debug(
    {
      sessionTurns: budget.turns,
      sessionTokens: budget.tokens,
      messageCount: options.messages.length,
      overrideModel: options.model ?? null,
      overrideProvider: options.provider ?? null,
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
  if (budget.tokens >= MAX_TOKENS_PER_SESSION) {
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
      pluginId: executor.manifest.id,
      assignment,
      hasChat: typeof (executor as { chat?: unknown }).chat === 'function',
      hasRunSubagent: typeof executor.runSubagent === 'function',
    },
    'intake: executor resolved',
  )

  const systemPrompt = buildIntakeSystemPrompt(options.context)
  const cwd = resolveWorkingDir(null)
  const intelligenceDir = resolveIntelligenceDir(null)
  const emptyMcp = createSdkMcpServer({ name: 'coro', tools: [] })
  const model = assignment.model

  const hookPolicy = { allowedTools: [] as string[], writeRoots: [] as string[] }

  try {
    // Preferred path: every executor that implements `chat()` serves
    // the intake conversation via a direct HTTP API call — no Claude
    // Code subprocess, no MCP bridge, no working-dir scaffolding. This
    // is the only path that works reliably across providers, since
    // Anthropic's `executePhase` spawns the Claude Code CLI which
    // exits with a non-zero code when invoked for a bare chat (no
    // tools, no agents, no repo).
    if (typeof executor.chat === 'function') {
      log?.debug({ pluginId: executor.manifest.id, model }, 'intake: invoking executor.chat()')
      const startedAt = Date.now()
      const result = await executor.chat({
        messages: options.messages.map(m => ({ role: m.role, content: m.content })),
        systemPrompt,
        model,
        signal: options.signal,
      })
      log?.debug(
        {
          pluginId: executor.manifest.id,
          elapsedMs: Date.now() - startedAt,
          outputChars: result.output.length,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        },
        'intake: chat() resolved',
      )

      const tokens = result.usage.inputTokens + result.usage.outputTokens
      budget.tokens += tokens

      const trimmed = result.output.trim()
      // Empty completions would yield a silent "done" — the chat UI
      // would dismiss the spinner but render nothing. Surface it as a
      // recoverable error so the dashboard can prompt a retry.
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
        pluginMcpServers: {},
        hookPolicy,
        allowedTools: [],
        maxTurns: 1,
        signal: options.signal,
      })

      const tokens = result.usage.inputTokens + result.usage.outputTokens
      budget.tokens += tokens
      if (tokens > MAX_TOKENS_PER_TURN) {
        // still deliver — budget is advisory per turn
      }

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
      pluginMcpServers: {},
      hookPolicy,
      sessionState: { conversationHistory: [] },
      maxTurns: 1,
      phase: 'intake',
      signal: options.signal,
    }

    let output = ''
    let inputTokens = 0
    let outputTokens = 0

    for await (const event of executor.executePhase(req)) {
      if (event.type === 'text' && event.content) {
        output += event.content
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

/** Test helper — reset in-memory session budgets. */
export function resetIntakeSessionBudgetsForTests(): void {
  sessionBudgets.clear()
}
