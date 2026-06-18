import { describe, it, expect } from 'vitest'
import {
  appendDeveloperMessagesToOpenAiTurn,
  DeveloperInputBuffer,
} from '../src/steering-input'
import type { ConversationMessage } from '@coro-ai/plugin-sdk'

describe('DeveloperInputBuffer', () => {
  it('aborts the in-flight turn when a developer message is pushed', () => {
    const turnAbortRef: { current: AbortController | null } = { current: null }
    const turnAbort = new AbortController()
    turnAbortRef.current = turnAbort

    const buffer = new DeveloperInputBuffer(turnAbortRef)
    buffer.push({ role: 'user', content: 'steer' })

    expect(turnAbort.signal.aborted).toBe(true)
    expect(buffer.size).toBe(1)
  })
})

describe('appendDeveloperMessagesToOpenAiTurn', () => {
  it('appends user items to OpenAI input and conversation history', () => {
    const inputItems: unknown[] = []
    const history: ConversationMessage[] = []
    const count = appendDeveloperMessagesToOpenAiTurn(
      [{ role: 'user', content: 'hello' }],
      inputItems,
      history,
    )
    expect(count).toBe(1)
    expect(inputItems).toEqual([{ role: 'user', content: 'hello' }])
    expect(history[0]?.meta?.['openaiItems']).toEqual([{ role: 'user', content: 'hello' }])
  })
})
