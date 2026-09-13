import { describe, expect, it } from 'vitest'
import type { ActivityItem } from '../src/components/activity/types'
import { conversationHasRun } from '../src/components/plan/generate-run-button'

describe('conversationHasRun', () => {
  it('is false until a current run card exists', () => {
    expect(conversationHasRun([])).toBe(false)
    expect(conversationHasRun([
      { kind: 'card', id: '1', card: { type: 'run', data: { state: 'superseded' } } },
    ] as ActivityItem[])).toBe(false)
  })

  it('is true for a draft or started run', () => {
    expect(conversationHasRun([
      { kind: 'card', id: '1', card: { type: 'run', data: { state: 'draft' } } },
    ] as ActivityItem[])).toBe(true)
    expect(conversationHasRun([
      { kind: 'card', id: '1', card: { type: 'run', data: { state: 'dispatched', jobId: 'j1' } } },
    ] as ActivityItem[])).toBe(true)
  })
})
