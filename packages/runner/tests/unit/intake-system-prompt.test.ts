import { describe, it, expect } from 'vitest'
import { buildIntakeSystemPrompt, renderDispatchedRunBlock } from '../../src/intake/system-prompt'

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
    expect(prompt).toContain('read_past_job_artifact')
    expect(prompt).toContain('list_past_job_files')
    expect(prompt).toContain('read_past_job_file')
  })

  it('omits past-job tools when they are not available', () => {
    const prompt = buildIntakeSystemPrompt(emptyContext, { toolsEnabled: true })
    expect(prompt).not.toContain('list_past_jobs')
    expect(prompt).not.toContain('get_past_job')
    expect(prompt).not.toContain('read_past_job_artifact')
  })
})

describe('renderDispatchedRunBlock', () => {
  it('points the agent at the run with the tools that can open it', () => {
    const block = renderDispatchedRunBlock('job-42')
    expect(block).toContain('job-42')
    expect(block).toContain('get_past_job')
    expect(block).toContain('read_past_job_artifact')
  })

  /**
   * A replay executor persists what it was sent, so an identical block is
   * what keeps repeated copies from reading as contradictory snapshots.
   */
  it('is identical on every turn for the same run', () => {
    expect(renderDispatchedRunBlock('job-42')).toBe(renderDispatchedRunBlock('job-42'))
  })
})
