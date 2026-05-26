import { describe, it, expect, vi } from 'vitest'
import {
  formatGuardrailDenialLine,
  formatGuardrailAgentReason,
} from '../../src/guardrails/denial-log'
import { GuardrailEngine, buildGuardrailContext } from '../../src/guardrails'
import { resolveGuardrails } from '../../src/guardrails/merge'
import type { Job } from '@coro-ai/cloud-protocol'

vi.mock('../../src/guardrails/checks/pr-diff-size', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/guardrails/checks/pr-diff-size')>()
  return {
    ...orig,
    gitDiffStat: vi.fn(async () => ({ lines: 10, files: 2 })),
  }
})

describe('formatGuardrailDenialLine', () => {
  it('includes rule id, tool name, and detail', () => {
    const line = formatGuardrailDenialLine({
      ruleId: 'pr-diff-size',
      on: 'scm.create_pr',
      toolName: 'mcp__coro__scm_create_pr',
      detail: 'Cannot evaluate PR diff size: repo missing.',
    })
    expect(line).toBe(
      '[guardrail] pr-diff-size blocked mcp__coro__scm_create_pr: Cannot evaluate PR diff size: repo missing.',
    )
  })

  it('falls back to product event when tool name is absent', () => {
    const line = formatGuardrailDenialLine({
      ruleId: 'pr-description',
      on: 'scm.create_pr',
      detail: 'PR description is too short.',
    })
    expect(line).toBe('[guardrail] pr-description blocked scm.create_pr: PR description is too short.')
  })
})

describe('formatGuardrailAgentReason', () => {
  it('uses rule title when present', () => {
    expect(
      formatGuardrailAgentReason(
        { id: 'pr-diff-size', title: 'PR diff size', check: 'pr-diff-size' },
        'too large',
      ),
    ).toBe('Guardrail "pr-diff-size" (PR diff size): too large')
  })
})

describe('GuardrailEngine activityLog', () => {
  const minimalJob = (overrides: Partial<Job> = {}): Job => ({
    id: 'job-test-1',
    type: 'job',
    status: 'running',
    phase: 'coding',
    workflowPath: 'workflows/job/workflow.md',
    params: { repoSlug: 'my-repo' },
    insights: [],
    workItems: [],
    prMappings: [],
    ...overrides,
  } as Job)

  it('appends one activity line per denial', async () => {
    const activityLog = vi.fn()
    const engine = GuardrailEngine.fromResolved(resolveGuardrails(null).resolved, {
      activityLog,
    })
    const decision = await engine.evaluate(
      'scm.create_pr',
      buildGuardrailContext({
        on: 'scm.create_pr',
        toolName: 'mcp__coro__scm_create_pr',
        toolInput: { description: 'short', repo: 'r', title: 't' },
        job: minimalJob(),
        workingDir: '/tmp/wd',
      }),
    )
    expect(decision.allow).toBe(false)
    expect(decision.ruleId).toBe('pr-description')
    expect(decision.on).toBe('scm.create_pr')
    expect(activityLog).toHaveBeenCalledTimes(1)
    expect(activityLog).toHaveBeenCalledWith(
      expect.stringMatching(/^\[guardrail\] pr-description blocked mcp__coro__scm_create_pr:/),
    )
  })

  it('does not append when all rules pass', async () => {
    const activityLog = vi.fn()
    const engine = GuardrailEngine.fromResolved(resolveGuardrails(null).resolved, {
      activityLog,
    })
    const body = ['## What', 'x'.repeat(100)].join('\n')
    await engine.evaluate(
      'scm.create_pr',
      buildGuardrailContext({
        on: 'scm.create_pr',
        toolInput: { description: body, repo: 'r', title: 't' },
        job: minimalJob({ phase: 'planning' }),
        workingDir: '/tmp/wd',
      }),
    )
    expect(activityLog).not.toHaveBeenCalled()
  })
})
