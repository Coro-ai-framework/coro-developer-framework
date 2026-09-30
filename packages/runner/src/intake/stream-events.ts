import type { ChatToolCallRecord } from '@coro-ai/plugin-sdk'
import { summarizeToolCall } from './tools'

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
  /** Set on tool frames produced by a delegated subagent, e.g. "Subagent 2". */
  subagent?: string
}

export function toolStartEvent(info: { name: string; input: unknown }, subagent?: string): IntakeStreamEvent {
  return { type: 'tool_start', name: info.name, input: info.input, ...(subagent ? { subagent } : {}) }
}

export function toolEndEvent(record: ChatToolCallRecord, subagent?: string): IntakeStreamEvent {
  return {
    type: 'tool_end',
    name: record.name,
    durationMs: record.durationMs,
    ok: !record.error,
    summary: record.error ?? summarizeToolCall(record.name, record.input, record.output),
    ...(record.error ? { error: record.error } : {}),
    ...(subagent ? { subagent } : {}),
  }
}

/**
 * Bridges synchronous executor hooks (fired from inside chat(), possibly from
 * several parallel subagents) to the async generator that writes SSE frames.
 */
export interface IntakeEventQueue {
  push(event: IntakeStreamEvent): void
  drain(): Generator<IntakeStreamEvent>
  /** Resolves when an event is queued or `task` settles, whichever comes first. */
  until(task: Promise<unknown>): Promise<void>
}

export function createIntakeEventQueue(): IntakeEventQueue {
  const queue: IntakeStreamEvent[] = []
  let notify: (() => void) | null = null
  return {
    push(event) {
      queue.push(event)
      notify?.()
      notify = null
    },
    *drain() {
      while (queue.length > 0) yield queue.shift()!
    },
    until(task) {
      if (queue.length > 0) return Promise.resolve()
      return Promise.race([
        task.then(() => undefined, () => undefined),
        new Promise<void>(resolve => { notify = resolve }),
      ])
    },
  }
}
