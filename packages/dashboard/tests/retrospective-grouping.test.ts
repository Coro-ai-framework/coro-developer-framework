import { describe, expect, it } from 'vitest'
import { composeApprovalMessage, groupFindings } from '../src/lib/retrospective'
import type { RetrospectiveFinding } from '../src/types'

function finding(id: string, over: Partial<RetrospectiveFinding> = {}): RetrospectiveFinding {
  return {
    id,
    title: `Finding ${id}`,
    category: 'runner-code',
    severity: 'medium',
    evidence: [],
    ...over,
  }
}

describe('groupFindings', () => {
  it('leaves ungrouped findings as one group each', () => {
    const groups = groupFindings([finding('finding-1'), finding('finding-2')])
    expect(groups.map(g => g.key)).toEqual(['finding-1', 'finding-2'])
    expect(groups.every(g => g.rootCause === undefined)).toBe(true)
  })

  it('gathers the symptoms of one root cause', () => {
    const groups = groupFindings([
      finding('finding-3', { rootCause: 'scm-clone-unhardened' }),
      finding('finding-4'),
      finding('finding-5', { rootCause: 'scm-clone-unhardened' }),
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0].rootCause).toBe('scm-clone-unhardened')
    expect(groups[0].findings.map(f => f.id)).toEqual(['finding-3', 'finding-5'])
    expect(groups[1].findings.map(f => f.id)).toEqual(['finding-4'])
  })

  it('anchors a group where its first symptom appeared in the report', () => {
    const groups = groupFindings([
      finding('finding-1'),
      finding('finding-2', { rootCause: 'shared' }),
      finding('finding-3', { rootCause: 'shared' }),
    ])
    expect(groups.map(g => g.key)).toEqual(['finding-1', 'root:shared'])
  })

  it('treats a blank rootCause as no grouping', () => {
    const groups = groupFindings([
      finding('finding-1', { rootCause: '  ' }),
      finding('finding-2', { rootCause: '' }),
    ])
    expect(groups).toHaveLength(2)
  })
})

describe('composeApprovalMessage with groups', () => {
  it('still emits a flat list of ids, so the shipping contract is unchanged', () => {
    const findings = [
      finding('finding-1'),
      finding('finding-3', { rootCause: 'shared' }),
      finding('finding-5', { rootCause: 'shared' }),
    ]
    const message = composeApprovalMessage(findings, new Set(['finding-3', 'finding-5']))

    expect(message).toContain('Approved findings: finding-3, finding-5')
    expect(message).toContain('Skipped findings: finding-1')
  })
})
