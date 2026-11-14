import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { parseWorkflowConfig } from '../../src/workflow-parser'

function coding(lane: string) {
  const markdown = readFileSync(
    path.resolve(__dirname, `../../../intelligence-base/layer/.claude/commands/coro/${lane}.md`),
    'utf8',
  )
  const phase = parseWorkflowConfig(markdown).phases.find(item => item.name === 'coding')
  if (!phase) throw new Error(`${lane} has no coding phase`)
  return phase
}

describe('coding phase review lenses', () => {
  it('standard declares the review lenses and the tool the reviewer calls', () => {
    const phase = coding('job')
    expect(phase.lenses?.map(lens => lens.name)).toEqual(['correctness', 'security', 'tests', 'design', 'verifier'])
    expect(phase.subagents?.find(item => item.name === 'code-reviewer')?.tools).toContain('mcp__coro__code_review_lenses')
    for (const lens of phase.lenses ?? []) expect(lens.tools).not.toContain('mcp__coro__review_read_file')
  })

  it('deep adds the architecture lens', () => {
    const phase = coding('job-deep')
    expect(phase.lenses?.map(lens => lens.name)).toEqual(['correctness', 'security', 'tests', 'design', 'architecture', 'verifier'])
    const architecture = phase.lenses?.find(lens => lens.name === 'architecture')
    expect(architecture?.tools).toContain('mcp__coro__read_memory')
    expect(architecture?.tools?.some(tool => tool.includes('review_reference'))).toBe(false)
  })

  it('fast declares none', () => {
    const phase = coding('job-fast')
    expect(phase.lenses ?? []).toEqual([])
    expect(phase.subagents?.find(item => item.name === 'code-reviewer')?.tools).not.toContain('mcp__coro__code_review_lenses')
  })
})
