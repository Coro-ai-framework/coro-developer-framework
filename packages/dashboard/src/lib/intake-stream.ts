import { jsonRequest } from './http'
import type { IntakeEvent } from '../components/activity/adapters/intake'
import type { ActivityItem } from '../components/activity/types'
import type { WorkflowOption } from '../workflows'

export interface IntakeStreamMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Flatten transcript items into the POST /intake/stream wire format. */
export function toIntakeMessages(items: ActivityItem[]): IntakeStreamMessage[] {
  return items
    .filter((item): item is Extract<ActivityItem, { kind: 'message' }> => item.kind === 'message')
    .map(item => ({ role: item.role, content: item.text }))
}

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

export async function runIntakeStream(options: {
  sessionId: string
  /** The new developer message. Prior turns live in the runner's session. */
  message: string
  /**
   * The browser's copy of the earlier turns. Only used if the runner has no
   * session for this id (e.g. it restarted mid-investigation).
   */
  transcript: IntakeStreamMessage[]
  context: IntakeStreamContext
  modelChoice?: IntakeModelChoice
  signal: AbortSignal
  onEvent: (event: IntakeEvent) => void
}): Promise<{ noLlm?: boolean; error?: string }> {
  const { sessionId, message, transcript, context, modelChoice, signal, onEvent } = options

  const response = await fetch('/intake/stream', {
    ...jsonRequest(
      {
        sessionId,
        message,
        transcript: transcript.map(m => ({ role: m.role, content: m.content })),
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
    signal,
  })

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; reason?: string }
    if (response.status === 503 || body.reason === 'no-llm') {
      return { noLlm: true, error: body.error ?? 'No LLM provider configured' }
    }
    throw new Error(body.error ?? `Plan mode failed (${response.status})`)
  }

  if (!response.body) throw new Error('No response body from plan mode stream')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

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
        let payload: IntakeEvent
        try {
          payload = JSON.parse(raw) as IntakeEvent
        } catch {
          continue
        }
        onEvent(payload)
      }
    }
  }

  return {}
}

/** Discards the runner-side conversation for an abandoned or dispatched session. */
export function discardIntakeSession(sessionId: string): void {
  void fetch(`/intake/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => {
    // The runner sweeps idle sessions anyway; a failed cleanup is not worth surfacing.
  })
}
