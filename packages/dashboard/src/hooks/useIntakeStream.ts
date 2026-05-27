import { useCallback, useRef, useState } from 'react'
import { jsonRequest } from '../lib/http'
import type { WorkflowOption } from '../workflows'

export interface IntakeChatMessage {
  role: 'user' | 'assistant'
  content: string
  toolCalls?: IntakeToolCall[]
}

export interface IntakeToolCall {
  name: string
  input?: unknown
  durationMs?: number
  ok?: boolean
  summary?: string
  error?: string
  status: 'running' | 'done'
}

interface IntakeStreamDone {
  type: 'done'
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
}

interface IntakeStreamToken {
  type: 'token'
  text: string
}

interface IntakeStreamToolStart {
  type: 'tool_start'
  name: string
  input?: unknown
}

interface IntakeStreamToolEnd {
  type: 'tool_end'
  name: string
  durationMs?: number
  ok?: boolean
  summary?: string
  error?: string
}

interface IntakeStreamError {
  type: 'error'
  message: string
  reason?: string
}

type IntakeStreamPayload =
  | IntakeStreamDone
  | IntakeStreamToken
  | IntakeStreamToolStart
  | IntakeStreamToolEnd
  | IntakeStreamError

export interface IntakeStreamContext {
  recentRepos: string[]
  recentReviewers: string[]
  availableWorkflows: WorkflowOption[]
  userLocale?: string
}

export interface IntakeModelChoice {
  provider?: string
  model?: string
}

export function useIntakeStream() {
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [noLlm, setNoLlm] = useState(false)
  const [activeToolCalls, setActiveToolCalls] = useState<IntakeToolCall[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const sessionIdRef = useRef<string>(
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `intake-${Date.now()}`,
  )
  const [turnCount, setTurnCount] = useState(0)
  const [totalTokens, setTotalTokens] = useState(0)

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(false)
    setActiveToolCalls([])
  }, [])

  const send = useCallback(
    async (
      messages: IntakeChatMessage[],
      context: IntakeStreamContext,
      onToken: (text: string) => void,
      modelChoice?: IntakeModelChoice,
      onToolCalls?: (calls: IntakeToolCall[]) => void,
    ): Promise<{
      assistantText: string
      toolCalls: IntakeToolCall[]
      usage?: IntakeStreamDone['usage']
      error?: string
      noLlm?: boolean
    }> => {
      setError(null)
      setNoLlm(false)
      setStreaming(true)
      setActiveToolCalls([])
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      let assistantText = ''
      const toolCalls: IntakeToolCall[] = []

      const syncTools = () => {
        setActiveToolCalls([...toolCalls])
        onToolCalls?.([...toolCalls])
      }

      try {
        const response = await fetch('/intake/stream', {
          ...jsonRequest(
            {
              sessionId: sessionIdRef.current,
              messages: messages.map(m => ({ role: m.role, content: m.content })),
              ...(modelChoice?.model?.trim()
                ? {
                    model: modelChoice.model.trim(),
                    ...(modelChoice.provider?.trim() ? { provider: modelChoice.provider.trim() } : {}),
                  }
                : {}),
              context: {
                recentRepos: context.recentRepos,
                recentReviewers: context.recentReviewers,
                availableWorkflows: context.availableWorkflows.map(w => ({
                  id: w.id,
                  name: w.name,
                  workflowPath: w.workflowPath,
                  description: w.description,
                })),
                userLocale: context.userLocale ?? navigator.language,
              },
            },
            { method: 'POST' },
          ),
          signal: controller.signal,
        })

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string; reason?: string }
          if (response.status === 503 || body.reason === 'no-llm') {
            setNoLlm(true)
            return { assistantText: '', toolCalls: [], noLlm: true, error: body.error ?? 'No LLM provider configured' }
          }
          throw new Error(body.error ?? `Plan mode failed (${response.status})`)
        }

        if (!response.body) throw new Error('No response body from plan mode stream')

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let usage: IntakeStreamDone['usage']

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const parts = buffer.split('\n\n')
          buffer = parts.pop() ?? ''

          for (const part of parts) {
            for (const line of part.split('\n')) {
              if (!line.startsWith('data: ')) continue
              const raw = line.slice(6).trim()
              if (!raw) continue
              let payload: IntakeStreamPayload
              try {
                payload = JSON.parse(raw) as IntakeStreamPayload
              } catch {
                continue
              }
              if (payload.type === 'token' && payload.text) {
                assistantText += payload.text
                onToken(payload.text)
              } else if (payload.type === 'tool_start') {
                toolCalls.push({
                  name: payload.name,
                  input: payload.input,
                  status: 'running',
                })
                syncTools()
              } else if (payload.type === 'tool_end') {
                // Match the most recent in-flight call with the same
                // name. The executor fires tool_end in the same order
                // it queued tool_start, so the last running one is
                // the one resolving now.
                const idx = toolCalls.findLastIndex(
                  t => t.name === payload.name && t.status === 'running',
                )
                if (idx >= 0) {
                  toolCalls[idx] = {
                    ...toolCalls[idx],
                    status: 'done',
                    durationMs: payload.durationMs,
                    ok: payload.ok,
                    summary: payload.summary,
                    error: payload.error,
                  }
                  syncTools()
                }
              } else if (payload.type === 'done') {
                usage = payload.usage
                if (payload.usage?.totalTokens) {
                  setTotalTokens(prev => prev + payload.usage!.totalTokens)
                }
              } else if (payload.type === 'error') {
                if (payload.reason === 'no-llm') {
                  setNoLlm(true)
                  return { assistantText, toolCalls, noLlm: true, error: payload.message }
                }
                throw new Error(payload.message)
              }
            }
          }
        }

        setTurnCount(c => c + 1)
        setActiveToolCalls([])
        return { assistantText, toolCalls, usage }
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          return { assistantText, toolCalls, error: 'Cancelled' }
        }
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        return { assistantText, toolCalls, error: message }
      } finally {
        setStreaming(false)
        abortRef.current = null
      }
    },
    [],
  )

  return {
    streaming,
    error,
    noLlm,
    turnCount,
    totalTokens,
    activeToolCalls,
    sessionId: sessionIdRef.current,
    send,
    cancel,
  }
}
