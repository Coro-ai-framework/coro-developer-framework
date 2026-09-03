import { describe, expect, it } from 'vitest'
import type { ActivityItem } from '../src/components/activity/types'
import {
  investigationHasProgress,
  investigationTitleFromItems,
  mergeInvestigationSummaries,
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
  })

  it('promotes a persisted summary to the top of the rail list', () => {
    const merged = mergeInvestigationSummaries(
      [
        { id: 'a', title: 'A', status: 'active', readiness: null, turnCount: 1, updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'b', title: 'B', status: 'active', readiness: null, turnCount: 1, updatedAt: '2026-01-02T00:00:00.000Z' },
      ],
      { id: 'a', title: 'A2', status: 'active', readiness: null, turnCount: 2, updatedAt: '2026-01-03T00:00:00.000Z' },
    )
    expect(merged.map(row => row.id)).toEqual(['a', 'b'])
    expect(merged[0]?.title).toBe('A2')
  })
})
