// ── runner-internals.test.ts ─────────────────────────────────────────────────
//
// Lockdown tests for the pure helpers inside `src/jobs/runner.ts`:
//
//   selectModel               — model alias → concrete model id
//                               (llm.aliases first, legacy claude block fallback).
//   derivePhaseCostUsd        — fresh-vs-resumed-session cost reconciliation.
//
// These tests run without spawning Claude or touching disk-bound config —
// every dependency is a literal fixture.

import { describe, it, expect } from 'vitest'
import {
  selectModel,
  derivePhaseCostUsd,
} from '../../src/jobs/runner'
import type { Settings } from '../../src/config/settings'

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeSettings(overrides: { planning?: string; coding?: string } = {}): Settings {
  return {
    claude: {
      auth: { method: 'apiKey', apiKey: 'sk-test' },
      planningModel: overrides.planning ?? 'claude-opus-4',
      codingModel: overrides.coding ?? 'claude-sonnet-4',
    },
  } as unknown as Settings
}

// ── selectModel ──────────────────────────────────────────────────────────────

describe('selectModel', () => {
  const settings = makeSettings({ planning: 'claude-opus-4', coding: 'claude-sonnet-4' })

  it('defaults to the planning model when phaseConf is null', () => {
    expect(selectModel(null, settings)).toBe('claude-opus-4')
  })

  it('defaults to the planning model when phaseConf is undefined', () => {
    expect(selectModel(undefined, settings)).toBe('claude-opus-4')
  })

  it('defaults to the planning model when phaseConf.model is missing', () => {
    expect(selectModel({}, settings)).toBe('claude-opus-4')
  })

  it('returns the planning model for model: "planning"', () => {
    expect(selectModel({ model: 'planning' }, settings)).toBe('claude-opus-4')
  })

  it('returns the coding model for model: "coding"', () => {
    expect(selectModel({ model: 'coding' }, settings)).toBe('claude-sonnet-4')
  })

  it('treats every non-"coding" value as a literal model id (forward-compat)', () => {
    // Phase 2+: any value that isn't a known alias passes through as a
    // literal model id so workflows can pin specific models
    // (e.g. `model: 'gpt-5-codex'`). Documented here so the migration
    // test catches drift.
    expect(selectModel({ model: 'reasoning' }, settings)).toBe('reasoning')
    expect(selectModel({ model: '' }, settings)).toBe('claude-opus-4')
  })

  it('honours settings.llm.aliases when present', () => {
    const s = makeSettings()
    ;(s as { llm?: unknown }).llm = {
      aliases: {
        coding: { provider: 'openai', model: 'gpt-5-codex' },
        planning: { provider: 'anthropic', model: 'claude-opus-4-1' },
      },
    }
    expect(selectModel({ model: 'coding' }, s)).toBe('gpt-5-codex')
    expect(selectModel({ model: 'planning' }, s)).toBe('claude-opus-4-1')
    expect(selectModel(null, s)).toBe('claude-opus-4-1')
  })
})

// ── derivePhaseCostUsd ───────────────────────────────────────────────────────

describe('derivePhaseCostUsd', () => {
  const billable = {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  }
  const zero = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  }

  it('returns 0 when no phase tokens were billed (avoids ghost charges)', () => {
    expect(
      derivePhaseCostUsd({
        reportedTotalCostUsd: 0.42,
        phaseTokens: zero,
        prePhaseCostUsd: 0,
      }),
    ).toBe(0)
  })

  it('returns the full reported cost on a fresh (non-resumed) session', () => {
    expect(
      derivePhaseCostUsd({
        reportedTotalCostUsd: 0.05,
        phaseTokens: billable,
        prePhaseCostUsd: 0.02, // ignored for fresh sessions
      }),
    ).toBe(0.05)
  })

  it('subtracts the pre-phase baseline when the session was resumed', () => {
    expect(
      derivePhaseCostUsd({
        reportedTotalCostUsd: 0.5,
        phaseTokens: billable,
        prePhaseCostUsd: 0.3,
        resumedSessionId: 'sess-abc',
      }),
    ).toBeCloseTo(0.2, 8)
  })

  it('falls back to the raw reported cost if delta is negative (defensive)', () => {
    // Anthropic occasionally reports a smaller cumulative cost than what we
    // already booked (rounding, retried frames). Booking a negative delta
    // would corrupt the running total, so we keep the raw value.
    expect(
      derivePhaseCostUsd({
        reportedTotalCostUsd: 0.05,
        phaseTokens: billable,
        prePhaseCostUsd: 0.4,
        resumedSessionId: 'sess-xyz',
      }),
    ).toBe(0.05)
  })

  it('treats non-numeric / negative reportedTotalCostUsd as 0', () => {
    expect(
      derivePhaseCostUsd({
        reportedTotalCostUsd: 'not a number',
        phaseTokens: billable,
        prePhaseCostUsd: 0,
      }),
    ).toBe(0)
    expect(
      derivePhaseCostUsd({
        reportedTotalCostUsd: -1.5,
        phaseTokens: billable,
        prePhaseCostUsd: 0,
      }),
    ).toBe(0)
  })

  it('counts cache-only usage as billable', () => {
    expect(
      derivePhaseCostUsd({
        reportedTotalCostUsd: 0.01,
        phaseTokens: { ...zero, cacheReadInputTokens: 200 },
        prePhaseCostUsd: 0,
      }),
    ).toBe(0.01)
    expect(
      derivePhaseCostUsd({
        reportedTotalCostUsd: 0.01,
        phaseTokens: { ...zero, cacheCreationInputTokens: 200 },
        prePhaseCostUsd: 0,
      }),
    ).toBe(0.01)
  })
})
