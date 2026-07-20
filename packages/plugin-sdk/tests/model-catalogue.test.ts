// Tests for the executor model-catalogue helpers that let plugins keep
// `listModels()` as the single source of truth for tier defaults.

import { describe, expect, it } from 'vitest'

import { defaultModelForTier, tierDefaultAliases } from '../src/helpers'
import type { ExecutorModelDescriptor } from '../src/types'

const CATALOGUE: ReadonlyArray<ExecutorModelDescriptor> = [
  // A newer model listed *first* for its tier but not flagged default —
  // it must not be promoted over the flagged one below.
  { id: 'exp-planner', displayName: 'Experimental Planner', contextTokens: 1_000, tier: 'planning' },
  { id: 'main-planner', displayName: 'Main Planner', contextTokens: 1_000, tier: 'planning', isDefault: true },
  { id: 'coder', displayName: 'Coder', contextTokens: 1_000, tier: 'coding', isDefault: true },
  { id: 'first-mini', displayName: 'First Mini', contextTokens: 1_000, tier: 'mini' },
]

describe('defaultModelForTier', () => {
  it('prefers the model flagged isDefault over catalogue order', () => {
    expect(defaultModelForTier(CATALOGUE, 'planning')).toBe('main-planner')
  })

  it('falls back to the first model of a tier when none is flagged', () => {
    expect(defaultModelForTier(CATALOGUE, 'mini')).toBe('first-mini')
  })

  it('returns undefined when the tier has no catalogued model', () => {
    const noMini = CATALOGUE.filter(m => m.tier !== 'mini')
    expect(defaultModelForTier(noMini, 'mini')).toBeUndefined()
  })
})

describe('tierDefaultAliases', () => {
  it('derives one entry per populated tier, keyed by tier:*', () => {
    expect(tierDefaultAliases(CATALOGUE, 'myprovider')).toEqual({
      'tier:planning': { provider: 'myprovider', model: 'main-planner' },
      'tier:coding': { provider: 'myprovider', model: 'coder' },
      'tier:mini': { provider: 'myprovider', model: 'first-mini' },
    })
  })

  it('omits tiers the provider does not ship a model for', () => {
    const planningOnly = CATALOGUE.filter(m => m.tier === 'planning')
    expect(tierDefaultAliases(planningOnly, 'p')).toEqual({
      'tier:planning': { provider: 'p', model: 'main-planner' },
    })
  })
})
