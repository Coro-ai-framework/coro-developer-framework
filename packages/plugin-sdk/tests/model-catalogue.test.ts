// Tests for the executor model-catalogue helpers that let plugins keep
// `listModels()` as the single source of truth for tier defaults.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { defaultModelForTier, tierDefaultAliases } from '../src/helpers'
import {
  calculateCostFromCatalogue,
  defaultAliasesFromCatalogue,
  loadExecutorModelCatalogue,
  parseExecutorModelCatalogue,
  supportsFromCatalogue,
} from '../src/model-catalogue'
import type { ExecutorModelCatalogue, ExecutorModelDescriptor } from '../src/types'

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

const JSON_CATALOGUE: ExecutorModelCatalogue = {
  idPrefixes: ['mock-'],
  idPatterns: ['^o\\d'],
  extraAliases: {
    planning: 'tier:planning',
    mini: 'tier:coding',
    'tier:mini': 'tier:coding',
  },
  models: [
    {
      id: 'mock-planner',
      displayName: 'Mock Planner',
      contextTokens: 1000,
      tier: 'planning',
      isDefault: true,
      pricing: { inputPerMTokens: 1, outputPerMTokens: 2, cacheReadPerMTokens: 0.1, cacheCreationPerMTokens: 1.5 },
    },
    {
      id: 'mock-coder',
      displayName: 'Mock Coder',
      contextTokens: 1000,
      tier: 'coding',
      isDefault: true,
      pricing: { inputPerMTokens: 3, outputPerMTokens: 9 },
    },
  ],
}

describe('parseExecutorModelCatalogue', () => {
  it('accepts a valid catalogue', () => {
    expect(parseExecutorModelCatalogue(JSON_CATALOGUE).models).toHaveLength(2)
  })

  it('rejects two isDefault models in the same tier', () => {
    expect(() => parseExecutorModelCatalogue({
      models: [
        { id: 'a', displayName: 'A', contextTokens: 1, tier: 'coding', isDefault: true },
        { id: 'b', displayName: 'B', contextTokens: 1, tier: 'coding', isDefault: true },
      ],
    })).toThrow(/two isDefault models/)
  })

  it('rejects invalid idPatterns', () => {
    expect(() => parseExecutorModelCatalogue({
      models: [{ id: 'a', displayName: 'A', contextTokens: 1 }],
      idPatterns: ['(unclosed'],
    })).toThrow(/regular expression/)
  })

  it('rejects an empty models array', () => {
    expect(() => parseExecutorModelCatalogue({ models: [] })).toThrow(/Invalid executor model catalogue/)
  })
})

describe('loadExecutorModelCatalogue', () => {
  it('reads a JSON file from disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-catalogue-'))
    const file = path.join(dir, 'models.json')
    fs.writeFileSync(file, JSON.stringify(JSON_CATALOGUE))
    const loaded = loadExecutorModelCatalogue(file)
    expect(loaded.models[0]?.id).toBe('mock-planner')
  })

  it('rejects invalid JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-catalogue-'))
    const file = path.join(dir, 'models.json')
    fs.writeFileSync(file, '{not json')
    expect(() => loadExecutorModelCatalogue(file)).toThrow(/Invalid JSON/)
  })
})

describe('supportsFromCatalogue', () => {
  it('matches catalogued ids, dated snapshots, prefixes, and patterns', () => {
    expect(supportsFromCatalogue(JSON_CATALOGUE, 'mock-planner')).toBe(true)
    expect(supportsFromCatalogue(JSON_CATALOGUE, 'mock-planner-20251022')).toBe(true)
    expect(supportsFromCatalogue(JSON_CATALOGUE, 'mock-experimental')).toBe(true)
    expect(supportsFromCatalogue(JSON_CATALOGUE, 'o4-mini')).toBe(true)
    expect(supportsFromCatalogue(JSON_CATALOGUE, 'claude-sonnet-5')).toBe(false)
    expect(supportsFromCatalogue(JSON_CATALOGUE, '')).toBe(false)
  })
})

describe('calculateCostFromCatalogue', () => {
  it('applies per-million input/output/cache pricing', () => {
    const cost = calculateCostFromCatalogue(JSON_CATALOGUE, 'mock-planner', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
    })
    expect(cost).toBeCloseTo(1 + 2 + 0.1 + 1.5, 5)
  })

  it('returns 0 when the model has no pricing row', () => {
    expect(calculateCostFromCatalogue(JSON_CATALOGUE, 'unknown', {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    })).toBe(0)
  })
})

describe('defaultAliasesFromCatalogue', () => {
  it('derives tier aliases and copies extraAliases onto them', () => {
    expect(defaultAliasesFromCatalogue(JSON_CATALOGUE, 'mock')).toEqual({
      'tier:planning': { provider: 'mock', model: 'mock-planner' },
      'tier:coding': { provider: 'mock', model: 'mock-coder' },
      'tier:mini': { provider: 'mock', model: 'mock-coder' },
      planning: { provider: 'mock', model: 'mock-planner' },
      mini: { provider: 'mock', model: 'mock-coder' },
    })
  })
})
