import { describe, expect, it } from 'vitest'
import type { ActivityItem } from '../src/components/activity/types'
import {
  investigationHasProgress,
  investigationTitleFromItems,
  truncateInvestigationTitle,
} from '../src/lib/intake-investigation'

describe('investigationTitleFromItems', () => {
  it('prefers the latest run service name, then the first user message', () => {
    const items: ActivityItem[] = [
      { kind: 'message', id: '1', role: 'user', text: 'Please look at decode in the API' },
      {
        kind: 'card',
        id: '2',
        card: {
          type: 'run',
          data: { run: { serviceName: 'api-service' }, state: 'draft' },
        },
      },
    ]
    expect(investigationTitleFromItems(items)).toBe('api-service')
    expect(investigationTitleFromItems([items[0]!])).toBe('Please look at decode in the API')
  })

  it('truncates long first messages the same way the tab subtitle used to', () => {
    const long = 'x'.repeat(48)
    expect(truncateInvestigationTitle(long)).toBe(`${'x'.repeat(40)}…`)
  })

  it('treats a user message or card as progress', () => {
    expect(investigationHasProgress([])).toBe(false)
    expect(investigationHasProgress([
      { kind: 'message', id: '1', role: 'assistant', text: 'hello' },
    ])).toBe(false)
    expect(investigationHasProgress([
      { kind: 'message', id: '1', role: 'user', text: 'hello' },
    ])).toBe(true)
    expect(investigationHasProgress([
      {
        kind: 'activity',
        id: 'a1',
        group: 'working',
        entries: [{
          id: 'e1',
          group: 'working',
          sourceName: 'list_past_jobs',
          status: 'done',
          runningLabel: 'Listed 0 past jobs',
          settledLabel: 'Listed 0 past jobs',
        }],
      },
    ])).toBe(false)
  })
})
