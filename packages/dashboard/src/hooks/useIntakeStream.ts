import { useCallback, useRef, useState } from 'react'
import { jsonRequest } from '../lib/http'
import type { WorkflowOption } from '../workflows'

export interface IntakeChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface IntakeStreamDone {
  type: 'done'
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
}

interface IntakeStreamToken {
  type: 'token'
  text: string
}

interface IntakeStreamError {
  type: 'error'
  message: string
  reason?: string
}

type IntakeStreamPayload = IntakeStreamDone | IntakeStreamToken | IntakeStreamError

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
  }, [])

  const send = useCallback(
    async (
      messages: IntakeChatMessage[],
      context: IntakeStreamContext,
      onToken: (text: string) => void,
      modelChoice?: IntakeModelChoice,
    ): Promise<{ assistantText: string; usage?: IntakeStreamDone['usage']; error?: string; noLlm?: boolean }> => {
      setError(null)
      setNoLlm(false)
      setStreaming(true)
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      let assistantText = ''

      try {
        const response = await fetch('/intake/stream', {
          ...jsonRequest(
            {
              sessionId: sessionIdRef.current,
              messages,
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
            return { assistantText: '', noLlm: true, error: body.error ?? 'No LLM provider configured' }
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
              } else if (payload.type === 'done') {
                usage = payload.usage
                if (payload.usage?.totalTokens) {
                  setTotalTokens(prev => prev + payload.usage!.totalTokens)
                }
              } else if (payload.type === 'error') {
                if (payload.reason === 'no-llm') {
                  setNoLlm(true)
                  return { assistantText, noLlm: true, error: payload.message }
                }
                throw new Error(payload.message)
              }
            }
          }
        }

        setTurnCount(c => c + 1)
        return { assistantText, usage }
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          return { assistantText, error: 'Cancelled' }
        }
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        return { assistantText, error: message }
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
    sessionId: sessionIdRef.current,
    send,
    cancel,
  }
}
