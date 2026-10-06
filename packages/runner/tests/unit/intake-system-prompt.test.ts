import { describe, it, expect } from 'vitest'
import { buildIntakeSubagentSystemPrompt, buildIntakeSystemPrompt, renderDispatchedRunBlock } from '../../src/intake/system-prompt'

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

  it('points broad reads at scm_checkout and does not suggest a shell clone', () => {
    const access = {
      modes: { files: 'allow' as const, filesWrite: 'ask' as const, shell: 'ask' as const, web: 'ask' as const },
      nativeFiles: true,
      nativeWeb: true,
      scratchDir: '/tmp/scratch',
      mcpAttached: [],
      mcpOnRequest: [],
    }
    const on = buildIntakeSystemPrompt(emptyContext, { toolsEnabled: true, checkoutEnabled: true, access })
    expect(on).toContain('scm_checkout')
    expect(on).toContain('Never clone with the shell')
    expect(on).toContain('.coro-source.json')
    expect(on).not.toContain('git clone --depth 1')
    const off = buildIntakeSystemPrompt(emptyContext, { toolsEnabled: true, access })
    expect(off).not.toContain('scm_checkout')
    expect(off).not.toContain('git clone --depth 1')
    expect(off).toContain('Do not clone repositories with the shell')
  })

  it('documents delegation only when subagents are enabled', () => {
    const on = buildIntakeSystemPrompt(emptyContext, { toolsEnabled: true, subagentsEnabled: true })
    const off = buildIntakeSystemPrompt(emptyContext, { toolsEnabled: true })
    expect(on).toContain('delegate_investigation')
    expect(on).toContain('stand alone')
    expect(off).not.toContain('Delegating')
  })
})

describe('buildIntakeSubagentSystemPrompt', () => {
  it('keeps the read-only rules and leaves run blocks to the parent', () => {
    const prompt = buildIntakeSubagentSystemPrompt()
    expect(prompt).toContain('scm_list_files')
    expect(prompt).toContain('never write')
    expect(prompt).toContain('<run>')
    expect(prompt).not.toContain('scm_checkout')
  })

  it('tells a subagent to check out instead of cloning when the tool is offered', () => {
    const prompt = buildIntakeSubagentSystemPrompt({ checkoutEnabled: true, scratchDir: '/tmp/scratch' })
    expect(prompt).toContain('scm_checkout')
    expect(prompt).toContain('Never clone with the shell')
    expect(prompt).toContain('/tmp/scratch')
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
