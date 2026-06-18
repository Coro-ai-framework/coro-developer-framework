import type { ConversationMessage, DeveloperInputChannel } from '@coro-ai/plugin-sdk'

/**
 * In-memory buffer for mid-phase developer steering messages. The OpenAI
 * executor drains this queue into the Responses API `input` array between
 * turns (and immediately after a steering interrupt aborts the in-flight
 * request).
 */
export class DeveloperInputBuffer {
  private readonly queue: ConversationMessage[] = []
  private readonly turnAbortRef: { current: AbortController | null }

  constructor(turnAbortRef: { current: AbortController | null }) {
    this.turnAbortRef = turnAbortRef
  }

  push(message: ConversationMessage): void {
    this.queue.push(message)
    // Abort the in-flight Responses request so the loop can drain and
    // continue. The dispatcher also calls interrupt(); this covers races
    // where push lands after interrupt() times out.
    this.turnAbortRef.current?.abort()
  }

  drain(): ConversationMessage[] {
    if (this.queue.length === 0) return []
    return this.queue.splice(0, this.queue.length)
  }

  get size(): number {
    return this.queue.length
  }
}

/** Wire the runner's {@link DeveloperInputChannel} to a {@link DeveloperInputBuffer}. */
export function wireDeveloperInputChannel(
  channel: DeveloperInputChannel | undefined,
  buffer: DeveloperInputBuffer,
  onClose?: () => void,
): void {
  if (!channel) return
  const upstreamClose = channel.close
  channel.push = (message) => buffer.push(message)
  channel.close = () => {
    try { upstreamClose?.() } finally { onClose?.() }
  }
}

export function appendDeveloperMessagesToOpenAiTurn(
  messages: readonly ConversationMessage[],
  inputItems: unknown[],
  history: ConversationMessage[],
): number {
  let appended = 0
  for (const message of messages) {
    const userItem = { role: 'user', content: message.content }
    inputItems.push(userItem)
    history.push({
      role: 'user',
      content: message.content,
      meta: { openaiItems: [userItem] },
    })
    appended++
  }
  return appended
}
