import { describe, expect, it } from 'vitest'
import type { ActivityItem } from '../src/components/activity/types'
import { toIntakeMessages } from '../src/lib/intake-stream'

describe('toIntakeMessages', () => {
  it('keeps user and assistant text and drops activity and notices', () => {
    const items: ActivityItem[] = [
      { kind: 'message', id: '1', role: 'user', text: 'https://example.atlassian.net/browse/WS-5144' },
      {
        kind: 'activity',
        id: '2',
        group: 'tracker-read',
        entries: [],
      },
      { kind: 'message', id: '3', role: 'assistant', text: '<run>{"repo":"x"}</run>' },
      { kind: 'notice', id: '4', tone: 'error', text: 'nope' },
    ]
    expect(toIntakeMessages(items)).toEqual([
      { role: 'user', content: 'https://example.atlassian.net/browse/WS-5144' },
      { role: 'assistant', content: '<run>{"repo":"x"}</run>' },
    ])
  })

  it('does not invent a greeting when there are no messages yet', () => {
    expect(toIntakeMessages([])).toEqual([])
  })

  it('folds findings and run cards into the seed transcript', () => {
    const items: ActivityItem[] = [
      { kind: 'message', id: '1', role: 'user', text: 'How does decode work?' },
      {
        kind: 'card',
        id: '2',
        card: {
          type: 'findings',
          data: { markdown: '## Decode\n\nIt is stateless.', state: 'current' },
        },
      },
      {
        kind: 'card',
        id: '3',
        card: {
          type: 'run',
          data: {
            run: {
              repo: 'org/api',
              serviceName: 'api',
              description: 'Make decode handle the empty payload case without throwing.',
              reviewers: 'alice, bob',
              workflowPath: 'workflows/job/workflow.md',
              interactive: true,
            },
            state: 'draft',
          },
        },
      },
    ]
    const messages = toIntakeMessages(items)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual({ role: 'user', content: 'How does decode work?' })
    expect(messages[1]?.content).toContain('<findings>')
    expect(messages[1]?.content).toContain('It is stateless.')
    expect(messages[1]?.content).toContain('<run>')
    expect(messages[1]?.content).toContain('org/api')
  })
})
