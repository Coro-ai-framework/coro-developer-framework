import { describe, expect, it } from 'vitest'
import { deriveWorkflowPhases } from '../src/lib/workflow-phases'
import type { Job } from '../src/types'

function job(partial: Partial<Job>): Job {
  return { id: 'job-1', phase: 'coding', ...partial } as Job
}

describe('deriveWorkflowPhases', () => {
  it('prefers the runner snapshot', () => {
    const phases = deriveWorkflowPhases(job({
      workflowPhases: [{ name: 'planning', status: 'planning' }, { name: 'coding', status: 'coding' }],
    }))
    expect(phases.map(p => p.name)).toEqual(['planning', 'coding'])
  })

  it('reconstructs from phase usage plus the current phase', () => {
    const phases = deriveWorkflowPhases(job({
      phase: 'review',
      phaseUsage: [{ phase: 'planning' }, { phase: 'coding' }, { phase: 'coding' }] as Job['phaseUsage'],
    }))
    expect(phases.map(p => p.name)).toEqual(['planning', 'coding', 'review'])
  })

  it('does not duplicate the current phase, and handles no job', () => {
    expect(deriveWorkflowPhases(job({
      phase: 'coding',
      phaseUsage: [{ phase: 'coding' }] as Job['phaseUsage'],
    })).map(p => p.name)).toEqual(['coding'])
    expect(deriveWorkflowPhases(null)).toEqual([])
  })
})
