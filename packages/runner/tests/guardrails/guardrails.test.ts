import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  resolveGuardrails,
  GuardrailEngine,
  buildGuardrailContext,
} from '../../src/guardrails'
import type { Job } from '@coro/cloud-protocol'

vi.mock('../../src/guardrails/checks/pr-diff-size', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/guardrails/checks/pr-diff-size')>()
  return {
    ...orig,
    gitDiffStat: vi.fn(async () => ({ lines: 10, files: 2 })),
  }
})

function minimalJob(overrides: Partial<Job> = {}): Job {
  return {
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
  } as Job
}

describe('resolveGuardrails', () => {
  it('loads bundled defaults with PR and merge rules', () => {
    const { bundled, resolved } = resolveGuardrails(null)
    expect(bundled.rules.length).toBeGreaterThanOrEqual(4)
    expect(resolved.enabled).toBe(true)
    expect(resolved.rules.some(r => r.id === 'pr-description')).toBe(true)
    expect(resolved.rules.some(r => r.id === 'pr-diff-size')).toBe(true)
    expect(resolved.rules.some(r => r.id === 'merge-requires-approval')).toBe(true)
    expect(resolved.rules.some(r => r.id === 'proposal-markdown-only')).toBe(true)
  })

  it('merges overrides by id', () => {
    const { resolved } = resolveGuardrails({
      rules: [{ id: 'pr-diff-size', config: { maxLines: 2000 } }],
    })
    const rule = resolved.rules.find(r => r.id === 'pr-diff-size')
    expect(rule?.config?.maxLines).toBe(2000)
    expect(rule?.source).toBe('override')
  })

  it('disables globally when enabled is false', () => {
    const engine = GuardrailEngine.fromResolved(
      resolveGuardrails({ enabled: false }).resolved,
    )
    expect(engine.isEnabled()).toBe(false)
  })
})

describe('GuardrailEngine pr-description', () => {
  it('blocks short descriptions', async () => {
    const engine = GuardrailEngine.fromResolved(resolveGuardrails(null).resolved)
    const decision = await engine.evaluate(
      'scm.create_pr',
      buildGuardrailContext({
        on: 'scm.create_pr',
        toolInput: { description: 'too short', repo: 'r', title: 't' },
        job: minimalJob(),
        workingDir: '/tmp/wd',
      }),
    )
    expect(decision.allow).toBe(false)
    expect(decision.reason).toMatch(/too short|minimum/i)
  })

  it('allows valid descriptions', async () => {
    const engine = GuardrailEngine.fromResolved(resolveGuardrails(null).resolved)
    const body = [
      '## What',
      'Add rate limiting to the users API endpoint so we stop abuse during traffic spikes.',
      '',
      '## How',
      'Middleware + Redis token bucket.',
    ].join('\n')
    const decision = await engine.evaluate(
      'scm.create_pr',
      buildGuardrailContext({
        on: 'scm.create_pr',
        toolInput: { description: body, repo: 'r', title: 't' },
        job: minimalJob({ phase: 'planning' }),
        workingDir: '/tmp/wd',
      }),
    )
    expect(decision.allow).toBe(true)
  })
})

describe('GuardrailEngine scope', () => {
  it('pr-diff-size only runs during coding phase', async () => {
    const engine = GuardrailEngine.fromResolved(resolveGuardrails(null).resolved)
    const planning = await engine.evaluate(
      'scm.create_pr',
      buildGuardrailContext({
        on: 'scm.create_pr',
        toolInput: { description: '## What\n' + 'x'.repeat(100), repo: 'r', title: 't' },
        job: minimalJob({ phase: 'planning' }),
        workingDir: '/tmp/wd',
      }),
    )
    expect(planning.allow).toBe(true)
  })
})

describe('GuardrailEngine merge-requires-approval', () => {
  const scmOk = (approvalCount: number) => ({
    scm: {
      getPrApprovalStatus: vi.fn(async () => ({
        ok: true as const,
        approvalCount,
        state: 'open',
      })),
    },
  })

  it('blocks merge when approval count is below minimum', async () => {
    const engine = GuardrailEngine.fromResolved(
      resolveGuardrails(null).resolved,
      scmOk(0),
    )
    const decision = await engine.evaluate(
      'scm.merge_pr',
      buildGuardrailContext({
        on: 'scm.merge_pr',
        toolInput: { repo: 'my-repo', prId: 42 },
        job: minimalJob({ phase: 'review' }),
        workingDir: '/tmp/wd',
      }),
    )
    expect(decision.allow).toBe(false)
    expect(decision.reason).toMatch(/approval/i)
  })

  it('allows merge when approvals meet minimum', async () => {
    const engine = GuardrailEngine.fromResolved(
      resolveGuardrails(null).resolved,
      scmOk(1),
    )
    const decision = await engine.evaluate(
      'scm.merge_pr',
      buildGuardrailContext({
        on: 'scm.merge_pr',
        toolInput: { repo: 'my-repo', prId: 42 },
        job: minimalJob({ phase: 'review' }),
        workingDir: '/tmp/wd',
      }),
    )
    expect(decision.allow).toBe(true)
  })

  it('does not run during coding phase', async () => {
    const fetch = vi.fn()
    const engine = GuardrailEngine.fromResolved(
      resolveGuardrails(null).resolved,
      { scm: { getPrApprovalStatus: fetch } },
    )
    const decision = await engine.evaluate(
      'scm.merge_pr',
      buildGuardrailContext({
        on: 'scm.merge_pr',
        toolInput: { repo: 'my-repo', prId: 42 },
        job: minimalJob({ phase: 'coding' }),
        workingDir: '/tmp/wd',
      }),
    )
    expect(decision.allow).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('runs for scm_merge_pr via evaluateToolBefore', async () => {
    const engine = GuardrailEngine.fromResolved(
      resolveGuardrails(null).resolved,
      scmOk(0),
    )
    const decision = await engine.evaluateToolBefore({
      toolName: 'mcp__coro__scm_merge_pr',
      toolInput: { repo: 'my-repo', prId: 7 },
      job: minimalJob({ phase: 'review-and-verify' }),
      workingDir: '/tmp/wd',
    })
    expect(decision.allow).toBe(false)
  })
})

describe('GuardrailEngine proposal-markdown-only', () => {
  it('blocks propose_change with non-md paths', async () => {
    const engine = GuardrailEngine.fromResolved(resolveGuardrails(null).resolved)
    const decision = await engine.evaluate(
      'propose_change',
      buildGuardrailContext({
        on: 'propose_change',
        toolInput: {
          type: 'memory-update',
          files: [{ path: 'gocache/foo', content: 'x' }],
        },
        job: minimalJob({ phase: 'evaluation' }),
        workingDir: '/tmp/wd',
      }),
    )
    expect(decision.allow).toBe(false)
    expect(decision.reason).toMatch(/\.md/)
  })

  it('allows memory-update entries with .md paths', async () => {
    const engine = GuardrailEngine.fromResolved(resolveGuardrails(null).resolved)
    const decision = await engine.evaluate(
      'propose_change',
      buildGuardrailContext({
        on: 'propose_change',
        toolInput: {
          type: 'memory-update',
          entries: [{ file: '.coro/memory/known-pitfalls.md', kind: 'pitfall', title: 't' }],
        },
        job: minimalJob({ phase: 'evaluation' }),
        workingDir: '/tmp/wd',
      }),
    )
    expect(decision.allow).toBe(true)
  })
})

describe('script guardrails', () => {
  let scriptsDir: string

  beforeEach(() => {
    scriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-guardrails-'))
  })

  it('runs a user script that blocks', async () => {
    const scriptName = 'block-all'
    fs.writeFileSync(
      path.join(scriptsDir, `${scriptName}.mjs`),
      'export default async () => ({ allow: false, reason: "blocked by test" })',
    )

    const { resolved } = resolveGuardrails({
      rules: [
        { id: 'pr-description', enabled: false },
        { id: 'pr-diff-size', enabled: false },
        {
          id: 'block-all',
          on: 'scm.create_pr',
          check: 'script',
          script: scriptName,
        },
      ],
    })
    resolved.scriptsDir = scriptsDir
    const engine = GuardrailEngine.fromResolved(resolved)
    const decision = await engine.evaluate(
      'scm.create_pr',
      buildGuardrailContext({
        on: 'scm.create_pr',
        toolInput: { description: '## What\n' + 'x'.repeat(100) },
        job: minimalJob(),
        workingDir: '/tmp/wd',
      }),
    )
    expect(decision.allow).toBe(false)
    expect(decision.reason).toMatch(/blocked by test/)
  })
})
