import { describe, it, expect } from 'vitest'
import { buildIntakeSystemPrompt } from '../../src/intake/system-prompt'

const emptyContext = {
  recentRepos: [],
  recentReviewers: [],
  availableWorkflows: [],
}

describe('buildIntakeSystemPrompt', () => {
  it('documents past-job tools when they are enabled', () => {
    const prompt = buildIntakeSystemPrompt(emptyContext, {
      toolsEnabled: true,
      pastJobsEnabled: true,
    })
    expect(prompt).toContain('list_past_jobs')
    expect(prompt).toContain('get_past_job')
    expect(prompt).toContain('past jobs')
  })

  it('omits past-job tools when they are not available', () => {
    const prompt = buildIntakeSystemPrompt(emptyContext, { toolsEnabled: true })
    expect(prompt).not.toContain('list_past_jobs')
    expect(prompt).not.toContain('get_past_job')
  })
})
