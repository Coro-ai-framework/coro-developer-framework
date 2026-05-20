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
  it('loads bundled defaults with two PR rules', () => {
    const { bundled, resolved } = resolveGuardrails(null)
    expect(bundled.rules.length).toBeGreaterThanOrEqual(2)
    expect(resolved.enabled).toBe(true)
    expect(resolved.rules.some(r => r.id === 'pr-description')).toBe(true)
    expect(resolved.rules.some(r => r.id === 'pr-diff-size')).toBe(true)
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
