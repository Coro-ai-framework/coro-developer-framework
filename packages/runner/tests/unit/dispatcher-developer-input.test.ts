import { describe, it, expect } from 'vitest'
import { buildDeveloperInputMessage, buildEscalationResponseMessage } from '../../src/jobs/dispatcher'
import type { Artifact } from '@coro/cloud-protocol'

function art(partial: Partial<Artifact> = {}): Artifact {
  return {
    id: 'art-1',
    phase: 'planning',
    kind: 'plan-md',
    title: 'Migration plan',
    data: {},
    createdBy: 'planning',
    createdAt: '2026-01-01T00:00:00Z',
    ...partial,
  }
}

describe('buildDeveloperInputMessage (developer-input resumes)', () => {
  it('includes the pause reason when awaitingEvent has developer-input: prefix', () => {
    const prompt = buildDeveloperInputMessage(
      'Yes, make it idempotent',
      'coding',
      'developer-input: unclear if X should be idempotent',
      [],
    )

    expect(prompt).toContain('[DEVELOPER RESPONSE]')
    expect(prompt).toContain('paused during phase: coding')
    expect(prompt).toContain('waiting for input on: "unclear if X should be idempotent"')
    expect(prompt).toContain('Developer said:')
    expect(prompt).toContain('"Yes, make it idempotent"')
  })

  it('omits reason line when awaitingEvent has no "developer-input:" prefix', () => {
    const prompt = buildDeveloperInputMessage(
      'please proceed',
      'planning',
      undefined,
      [],
    )
    expect(prompt).toContain('[DEVELOPER RESPONSE]')
    expect(prompt).not.toContain('waiting for input on:')
  })

  it('lists artefacts posted during the current phase', () => {
    const prompt = buildDeveloperInputMessage(
      'Looks good, go ahead',
      'planning',
      'developer-input: approval after planning',
      [art()],
    )

    expect(prompt).toContain('plan-md: Migration plan')
  })

  it('limits artefact listing to the last 10 entries', () => {
    const artifacts = Array.from({ length: 15 }, (_, i) =>
      art({ id: `art-${i}`, title: `artefact ${i}`, kind: 'file' }),
    )
    const prompt = buildDeveloperInputMessage('ok', 'planning', undefined, artifacts)
    expect(prompt).toContain('artefact 14')
    expect(prompt).toContain('artefact 5')
    expect(prompt).not.toContain('artefact 0')
    expect(prompt).not.toContain('artefact 4')
  })

  it('instructs agent to finish the phase normally (runner auto-advances) and can goto_phase on rework', () => {
    const prompt = buildDeveloperInputMessage('x', 'coding', undefined, [])
    expect(prompt).toContain('Finish the phase normally')
    expect(prompt).toContain('runner will auto-advance')
    expect(prompt).toContain('goto_phase')
  })

  it('instructs agent to record reusable guidance via add_insight', () => {
    const prompt = buildDeveloperInputMessage('x', 'planning', undefined, [])
    expect(prompt).toContain('add_insight')
  })
})

describe('buildEscalationResponseMessage (escalation resumes)', () => {
  it('includes the escalation reason and developer reply', () => {
    const prompt = buildEscalationResponseMessage(
      'Tell me how to update the settings, then wait for me.',
      'coding',
      'Need the developer to allowlist nuget.org in the sandbox.',
      [],
    )

    expect(prompt).toContain('previously escalated during phase: coding')
    expect(prompt).toContain('Your escalation reason was:')
    expect(prompt).toContain('Need the developer to allowlist nuget.org in the sandbox.')
    expect(prompt).toContain('Developer said:')
    expect(prompt).toContain('Tell me how to update the settings, then wait for me.')
  })

  it('tells the agent to re-park with await_event when the developer still needs to act', () => {
    const prompt = buildEscalationResponseMessage('give me the steps', 'coding', undefined, [])
    expect(prompt).toContain('await_event({ eventName: "developer-input: <short reason>" })')
    expect(prompt).toContain('job stays with you instead of auto-advancing')
    expect(prompt).toContain('instructions, research, or any out-of-band action')
  })
})
