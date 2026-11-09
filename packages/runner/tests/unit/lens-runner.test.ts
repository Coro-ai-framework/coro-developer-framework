import { describe, expect, it } from 'vitest'
import { lensResultSchema, LensRunError, runLenses, type LensRun } from '../../src/reviews/lens-runner'

const usage = (costUsd: number) => ({ inputTokens: 10, outputTokens: 1, costUsd })

describe('lensResultSchema', () => {
  it('accepts sourcesUsed as strings or as {kind, ref} citations', () => {
    const parsed = lensResultSchema.parse({
      findings: [],
      sourcesUsed: ['docs/adr/0001.md', { kind: 'adr', ref: 'docs/adr/0002.md' }, { ref: 'go.mod' }],
    })
    expect(parsed.sourcesUsed).toEqual(['docs/adr/0001.md', 'adr:docs/adr/0002.md', 'go.mod'])
  })
})

describe('runLenses', () => {
  it('keeps the other lenses and the failed lens spend when one lens fails', async () => {
    const result = await runLenses(
      ['correctness', 'architecture', 'security'],
      2,
      name => name,
      async (name): Promise<LensRun> => {
        if (name === 'architecture') throw new LensRunError('architecture lens output failed validation twice', usage(0.7))
        return { name, result: { findings: [], sourcesUsed: [] }, usage: usage(0.5) }
      },
    )

    expect(result.runs.map(run => run.name)).toEqual(['correctness', 'security'])
    expect(result.failed).toEqual([
      { name: 'architecture', error: 'architecture lens output failed validation twice', usage: usage(0.7) },
    ])
    expect(result.spend.costUsd).toBeCloseTo(1.7)
  })

  it('still throws when the phase was aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runLenses(['correctness'], 1, name => name, async () => {
      throw new Error('aborted')
    }, controller.signal)).rejects.toThrow('aborted')
  })
})
