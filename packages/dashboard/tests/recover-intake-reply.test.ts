import { describe, expect, it } from 'vitest'
import type { ActivityItem } from '../src/components/activity/types'
import { recoverIntakeReply } from '../src/lib/recover-intake-reply'

const user: ActivityItem = { kind: 'message', id: 'u', role: 'user', text: 'How does auth work?' }

describe('recoverIntakeReply', () => {
  it('appends the recorded reply and its findings when the snapshot stopped mid-turn', () => {
    const assistant = 'Auth uses sessions.\n\n<findings>\n# Auth\nSession cookies.\n</findings>'
    const first = recoverIntakeReply([user], [{ user: 'How does auth work?', assistant }], [])
    expect(first.items.filter(item => item.kind === 'message' && item.role === 'assistant')).toHaveLength(1)
    expect(first.items.some(item => item.kind === 'card' && item.card.type === 'findings')).toBe(true)

    const again = recoverIntakeReply(first.items, [{ assistant }], [])
    expect(again.items.filter(item => item.kind === 'message')).toHaveLength(2)
    expect(again.items.filter(item => item.kind === 'card' && item.card.type === 'findings')).toHaveLength(1)
  })

  it('replaces a partial assistant bubble with the recorded reply', () => {
    const partial: ActivityItem = { kind: 'message', id: 'a', role: 'assistant', text: 'Auth uses' }
    const recovered = recoverIntakeReply(
      [user, partial],
      [{ assistant: 'Auth uses sessions.' }],
      [],
    )
    const assistants = recovered.items.filter(item => item.kind === 'message' && item.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]).toMatchObject({ text: 'Auth uses sessions.' })
  })
})
