import { describe, expect, it } from 'vitest'
import { GuardrailEngine } from '../../src/guardrails/engine'
import { resolveGuardrails } from '../../src/guardrails'
import type { DecisionProvider } from '../../src/clients/decision'
import type { Job } from '@coro-ai/cloud-protocol'
import { buildGuardrailContext } from '../../src/guardrails'

function engine(decision?: DecisionProvider): GuardrailEngine {
  return GuardrailEngine.fromResolved({
    enabled: true,
    scriptsDir: '/tmp',
    rules: [{
      id: 'decision-pr',
      on: 'scm.create_pr',
      check: 'decision',
      enabled: true,
      source: 'custom',
    }],
  }, { decision })
}

function ctx() {
  return buildGuardrailContext({
    on: 'scm.create_pr',
    toolName: 'mcp__coro__scm_create_pr',
    toolInput: { description: 'Adds a feature', repo: 'svc' },
    job: {
      id: 'job-1',
      phase: 'coding',
      workflowPath: 'workflows/job/workflow.md',
      params: { repoSlug: 'svc' },
    } as Job,
    workingDir: '/tmp/work',
  })
}

describe('decision guardrail check', () => {
  it('is not in the bundled defaults', () => {
    const { bundled } = resolveGuardrails(null)
    expect(bundled.rules.some(r => r.check === 'decision')).toBe(false)
  })
  it('allows when no client is wired', async () => {
    const decision = await engine().evaluate('scm.create_pr', ctx())
    expect(decision.allow).toBe(true)
  })

  it('allows when the provider is unavailable', async () => {
    const decision = await engine({
      providerId: 'jev',
      ask: async () => ({ available: false, reason: 'down' }),
    }).evaluate('scm.create_pr', ctx())
    expect(decision.allow).toBe(true)
  })

  it('allows when the provider throws', async () => {
    const decision = await engine({
      providerId: 'jev',
      ask: async () => { throw new Error('boom') },
    }).evaluate('scm.create_pr', ctx())
    expect(decision.allow).toBe(true)
  })

  it('denies when secrets noul is at or above the threshold', async () => {
    const decision = await engine({
      providerId: 'jev',
      ask: async () => ({
        available: true,
        model: 'jev-1.13.0',
        latencyMs: 10,
        inputTokens: 4,
        answers: {
          matches: { type: 'noul', noul: 0.9 },
          secrets: { type: 'noul', noul: 0.8 },
        },
      }),
    }).evaluate('scm.create_pr', ctx())
    expect(decision.allow).toBe(false)
    expect(decision.reason).toMatch(/secret/)
  })

  it('denies when the description does not match the change', async () => {
    const decision = await engine({
      providerId: 'jev',
      ask: async () => ({
        available: true,
        model: 'jev-1.13.0',
        latencyMs: 10,
        inputTokens: 4,
        answers: {
          matches: { type: 'noul', noul: 0.1 },
          secrets: { type: 'noul', noul: 0.05 },
        },
      }),
    }).evaluate('scm.create_pr', ctx())
    expect(decision.allow).toBe(false)
    expect(decision.reason).toMatch(/does not look like it matches/)
  })

  it('allows a clean matching description', async () => {
    const decision = await engine({
      providerId: 'jev',
      ask: async () => ({
        available: true,
        model: 'jev-1.13.0',
        latencyMs: 10,
        inputTokens: 4,
        answers: {
          matches: { type: 'noul', noul: 0.9 },
          secrets: { type: 'noul', noul: 0.05 },
        },
      }),
    }).evaluate('scm.create_pr', ctx())
    expect(decision.allow).toBe(true)
  })
})
