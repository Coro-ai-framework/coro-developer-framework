import { describe, it, expect } from 'vitest'
import {
  buildWorkspaceLayoutPromptBlock,
  resolveJobWorkspaceLayout,
} from '../../src/jobs/workspace-layout'
import { JobType, type Job } from '@coro-ai/cloud-protocol'
import { emptyTokenUsage } from '../../src/jobs/helpers'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'ws-job',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: { repoSlug: 'svc' },
    triggerSource: 'cli',
    status: 'running',
    phase: 'coding',
    currentWorkItem: null,
    workItems: [],
    workItemLoopCount: 0,
    prMappings: [],
    interactive: false,
    artifacts: [],
    insights: [],
    tokenUsage: emptyTokenUsage(),
    phaseUsage: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('resolveJobWorkspaceLayout', () => {
  it('prefers persisted checkout params over repoSlug', () => {
    const layout = resolveJobWorkspaceLayout(
      makeJob({
        params: {
          repoSlug: 'old',
          repoCheckoutDir: 'my-repo',
          repoCheckoutAbsDir: '/work/ws-job/my-repo',
        },
      }),
      '/work/ws-job',
    )
    expect(layout.repoCheckoutDir).toBe('my-repo')
    expect(layout.repoCheckoutAbsDir).toBe('/work/ws-job/my-repo')
  })
})

describe('buildWorkspaceLayoutPromptBlock', () => {
  it('is language-agnostic', () => {
    const block = buildWorkspaceLayoutPromptBlock(
      resolveJobWorkspaceLayout(makeJob(), '/work/ws-job'),
    )
    expect(block).toContain('## Workspace layout')
    expect(block).toContain('/work/ws-job/svc')
    expect(block).toContain('{language}-conventions')
    expect(block).not.toMatch(/\bgo build\b/)
    expect(block).not.toMatch(/\bdotnet build\b/)
  })
})
