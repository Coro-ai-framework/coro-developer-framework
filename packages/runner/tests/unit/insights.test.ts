import { describe, it, expect } from 'vitest'
import { isInsightRejected, propagableInsights } from '../../src/insights'
import type { Insight } from '@coro-ai/cloud-protocol'

function insight(overrides: Partial<Insight> = {}): Insight {
  return {
    phase: 'coding',
    category: 'workaround',
    summary: 's',
    detail: 'd',
    ...overrides,
  }
}

describe('isInsightRejected', () => {
  it('is false for pending, approved, and absent status', () => {
    expect(isInsightRejected(insight({ status: 'pending' }))).toBe(false)
    expect(isInsightRejected(insight({ status: 'approved' }))).toBe(false)
    expect(isInsightRejected(insight())).toBe(false)
  })

  it('is true for rejected', () => {
    expect(isInsightRejected(insight({ status: 'rejected' }))).toBe(true)
  })
})

describe('propagableInsights', () => {
  it('returns empty for undefined or empty input', () => {
    expect(propagableInsights(undefined)).toEqual([])
    expect(propagableInsights([])).toEqual([])
  })

  it('drops rejected and keeps pending and approved', () => {
    const pending = insight({ status: 'pending', summary: 'pending' })
    const approved = insight({ status: 'approved', summary: 'approved' })
    const rejected = insight({ status: 'rejected', summary: 'rejected' })

    expect(propagableInsights([pending, approved, rejected])).toEqual([pending, approved])
  })
})
