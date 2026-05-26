import { createSdkMcpServer } from '@coro-ai/plugin-sdk'
import type { PhaseExecutionRequest } from '@coro-ai/plugin-sdk'
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
}

function getBudget(sessionId: string): SessionBudget {
  const existing = sessionBudgets.get(sessionId)
  if (existing) return existing
  const fresh = { turns: 0, tokens: 0 }
  sessionBudgets.set(sessionId, fresh)
  return fresh
}

export async function* runIntakeStream(options: RunIntakeOptions): AsyncGenerator<IntakeStreamEvent> {
  const budget = getBudget(options.sessionId)

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

  let executor
  try {
    executor = options.registry.resolveExecutor({ model: selectModel({ tier: 'planning' }, options.settings) })
  } catch (err) {
    const message = (err as Error).message
    if (/executor|provider|llm/i.test(message)) {
      yield { type: 'error', message: 'No LLM provider configured. Configure one in Settings.', reason: 'no-llm' } as IntakeStreamEvent & { reason?: string }
      return
    }
    yield { type: 'error', message }
    return
  }

  const systemPrompt = buildIntakeSystemPrompt(options.context)
  const userPrompt = formatIntakeUserPrompt(options.messages)
  const cwd = resolveWorkingDir(null)
  const intelligenceDir = resolveIntelligenceDir(null)
  const emptyMcp = createSdkMcpServer({ name: 'coro', tools: [] })
  const model = selectModel({ tier: 'planning' }, options.settings)

  const hookPolicy = { allowedTools: [] as string[], writeRoots: [] as string[] }

  try {
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
    yield { type: 'error', message: (err as Error).message }
  }
}

/** Test helper — reset in-memory session budgets. */
export function resetIntakeSessionBudgetsForTests(): void {
  sessionBudgets.clear()
}
