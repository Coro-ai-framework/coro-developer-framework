import { describe, expect, it } from 'vitest'
import type { Investigation, InvestigationPatch } from '@coro-ai/cloud-protocol'
import {
  clampInvestigationListQuery,
  investigationIsPersistable,
  mergeInvestigation,
  titleFromTurns,
  toInvestigationSummary,
  truncateInvestigationTitle,
} from '../../src/state/investigation'

function base(overrides: Partial<Investigation> = {}): Investigation {
  return {
    id: 'inv-1',
    title: 'Add logging',
    status: 'active',
    items: [{ kind: 'message', role: 'user', text: 'Add logging' }],
    turns: [{ user: 'Add logging', assistant: 'Looking.', evidence: [] }],
    modelChoice: { provider: 'anthropic', model: 'claude' },
    readiness: { state: 'investigating', openQuestions: ['which repo?'], note: '' },
    turnCount: 1,
    tokens: 40,
    contextUsed: 40,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('mergeInvestigation', () => {
  it('keeps items when a stream turn omits them', () => {
    const merged = mergeInvestigation(base(), {
      id: 'inv-1',
      turns: [{ user: 'Add logging', assistant: 'Done.', evidence: [] }],
      tokens: 80,
    }, '2026-01-01T01:00:00.000Z')
    expect(merged.items).toEqual(base().items)
    expect(merged.turns[0]?.assistant).toBe('Done.')
    expect(merged.tokens).toBe(80)
    expect(merged.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('keeps turns when a dashboard PUT omits them', () => {
    const merged = mergeInvestigation(base(), {
      id: 'inv-1',
      items: [{ kind: 'message', role: 'user', text: 'edited' }],
      title: 'edited',
    } as InvestigationPatch, '2026-01-01T01:00:00.000Z')
    expect(merged.turns).toEqual(base().turns)
    expect(merged.items).toEqual([{ kind: 'message', role: 'user', text: 'edited' }])
  })

  it('clears executorSession when the patch sends null', () => {
    const existing = base({ executorSession: { sessionId: 'claude-1' }, executorId: 'anthropic' })
    const merged = mergeInvestigation(existing, {
      id: 'inv-1',
      executorSession: null,
      executorId: null,
    }, '2026-01-01T01:00:00.000Z')
    expect(merged.executorSession).toBeUndefined()
    expect(merged.executorId).toBeUndefined()
  })
})

describe('investigation helpers', () => {
  it('does not persist an empty greeting', () => {
    expect(investigationIsPersistable(base({ items: [], turns: [], status: 'active' }))).toBe(false)
  })

  it('persists a user message even without turns yet', () => {
    expect(investigationIsPersistable(base({ turns: [] }))).toBe(true)
  })

  it('truncates titles and summarises without items/turns', () => {
    expect(truncateInvestigationTitle('abcdefghijklmnopqrstuvwxyz0123456789XXXXY')).toBe(
      'abcdefghijklmnopqrstuvwxyz0123456789XXXX…',
    )
    expect(titleFromTurns([{ user: '  Hello world  ', assistant: '', evidence: [] }])).toBe('Hello world')
    const summary = toInvestigationSummary(base({ dispatchedJobId: 'job-1' }))
    expect(summary).toMatchObject({ id: 'inv-1', title: 'Add logging', dispatchedJobId: 'job-1' })
    expect('items' in summary).toBe(false)
    expect('turns' in summary).toBe(false)
  })

  it('clamps list pagination', () => {
    expect(clampInvestigationListQuery({ limit: 0, offset: -4 })).toEqual({ limit: 1, offset: 0 })
    expect(clampInvestigationListQuery({ limit: 999, offset: 3 })).toEqual({ limit: 50, offset: 3 })
    expect(clampInvestigationListQuery()).toEqual({ limit: 5, offset: 0 })
  })
})
