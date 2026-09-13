import { describe, expect, it } from 'vitest'
import { parseExecutorModelCatalogue } from '@coro-ai/plugin-sdk'
import { buildExecutorModelsJson, buildSkeleton } from '../../cli/commands/plugin'

describe('coro plugin init --kind executor', () => {
  it('scaffolds a PhaseExecutorBase class that loads models.json', () => {
    const src = buildSkeleton('acme-llm', 'executor')
    expect(src).toContain("kind: 'executor'")
    expect(src).toContain('PhaseExecutorBase')
    expect(src).toContain('loadExecutorModelCatalogue')
    expect(src).toContain('models.json')
    expect(src).toContain('executePhase')
    expect(src).not.toContain('ANTHROPIC_MODELS')
  })

  it('emits a valid models.json catalogue with one default per tier', () => {
    const json = JSON.parse(buildExecutorModelsJson('acme-llm')) as unknown
    const catalogue = parseExecutorModelCatalogue(json)
    expect(catalogue.models.map(m => m.id)).toEqual([
      'acme-llm-planner',
      'acme-llm-coder',
      'acme-llm-mini',
    ])
    expect(catalogue.extraAliases?.planning).toBe('tier:planning')
  })
})
