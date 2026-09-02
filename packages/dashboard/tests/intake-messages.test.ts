import { describe, expect, it } from 'vitest'
import type { ActivityItem } from '../src/components/activity/types'
import { toIntakeMessages } from '../src/lib/intake-stream'

describe('toIntakeMessages', () => {
  it('keeps user and assistant text and drops activity, cards, and notices', () => {
    const items: ActivityItem[] = [
      { kind: 'message', id: '1', role: 'user', text: 'https://example.atlassian.net/browse/WS-5144' },
      {
        kind: 'activity',
        id: '2',
        group: 'tracker-read',
        entries: [],
      },
      { kind: 'message', id: '3', role: 'assistant', text: '<brief>{"repo":"x"}</brief>' },
      { kind: 'notice', id: '4', tone: 'error', text: 'nope' },
    ]
    expect(toIntakeMessages(items)).toEqual([
      { role: 'user', content: 'https://example.atlassian.net/browse/WS-5144' },
      { role: 'assistant', content: '<brief>{"repo":"x"}</brief>' },
    ])
  })

  it('does not invent a greeting when there are no messages yet', () => {
    expect(toIntakeMessages([])).toEqual([])
  })
})
