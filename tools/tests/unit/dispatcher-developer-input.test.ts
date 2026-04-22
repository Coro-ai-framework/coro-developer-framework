import { describe, it, expect } from 'vitest'
import { buildDeveloperInputMessage } from '../../src/jobs/dispatcher'
import type { Artifact } from '../../src/jobs/types'

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

describe('buildDeveloperInputMessage', () => {
  it('builds a checkpoint (phase-boundary) prompt with next phase guidance', () => {
    const prompt = buildDeveloperInputMessage(
      'Looks good, go ahead',
      'planning',
      'developer-input: approval after planning',
      'coding',
      [art()],
    )

    expect(prompt).toContain('[DEVELOPER RESPONSE — INTERACTIVE CHECKPOINT]')
    expect(prompt).toContain('parked waiting for developer approval after phase: planning')
    expect(prompt).toContain('Next phase (if approved): coding')
    expect(prompt).toContain('plan-md: Migration plan')
    expect(prompt).toContain('"Looks good, go ahead"')
    expect(prompt).toContain('`mcp__a5__goto_phase`')
    expect(prompt).toContain('"coding"')
  })

  it('builds a mid-phase prompt when awaitingNextPhase is undefined', () => {
    const prompt = buildDeveloperInputMessage(
      'Yes, make it idempotent',
      'coding',
      'developer-input: unclear if X should be idempotent',
      undefined,
      [],
    )

    expect(prompt).toContain('paused mid-phase during: coding')
    expect(prompt).toContain('waiting for input on: "unclear if X should be idempotent"')
    expect(prompt).toContain('Developer said:')
    expect(prompt).toContain('"Yes, make it idempotent"')
    expect(prompt).toContain('continue your current phase')
    // Mid-phase message should NOT instruct goto_phase
    expect(prompt).not.toContain('`mcp__a5__goto_phase`')
  })

  it('omits reason line when awaitingEvent has no "developer-input:" prefix', () => {
    const prompt = buildDeveloperInputMessage(
      'please proceed',
      'planning',
      undefined,
      'coding',
      [],
    )
    expect(prompt).not.toContain('waiting for input on:')
  })

  it('limits artefact listing to the last 10 entries', () => {
    const artifacts = Array.from({ length: 15 }, (_, i) =>
      art({ id: `art-${i}`, title: `artefact ${i}`, kind: 'file' }),
    )
    const prompt = buildDeveloperInputMessage('ok', 'planning', undefined, 'coding', artifacts)
    // Should include the last 10, not the first
    expect(prompt).toContain('artefact 14')
    expect(prompt).toContain('artefact 5')
    expect(prompt).not.toContain('artefact 0')
    expect(prompt).not.toContain('artefact 4')
  })

  it('instructs agent to record reusable guidance via add_insight', () => {
    const prompt = buildDeveloperInputMessage('x', 'planning', undefined, 'coding', [])
    expect(prompt).toContain('add_insight')
  })
})
