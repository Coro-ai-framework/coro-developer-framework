import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildIntelligenceCatalogue } from '../../src/intelligence-catalogue'

const START = '<!-- standalone:start -->'
const END = '<!-- standalone:end -->'

const WORKFLOW = `---
kind: job
phases:
  - name: planning
    agent: .claude/agents/planner.md
    status: planning
---

# Workflow: Demo

Runs the demo.
`

const AGENT = `---
name: planner
description: "Plans the work before any code is written."
---

# Agent: Planner

${START}
Outside the Coro runner, see CLAUDE.md.
${END}

Reads the request and writes the plan.
`

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'coro-catalogue-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function put(layer: string, rel: string, content: string): Promise<string> {
  const abs = path.join(root, layer, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content)
  return path.join(root, layer)
}

describe('buildIntelligenceCatalogue (native layout)', () => {
  it('lists workflows, agents, skills and memory from their native folders', async () => {
    const base = await put('base', '.claude/commands/coro/job.md', WORKFLOW)
    await put('base', '.claude/agents/planner.md', AGENT)
    await put('base', '.claude/skills/feature-planning/SKILL.md', '---\nname: feature-planning\ndescription: Plan features.\n---\n\n# Feature planning\n')
    await put('base', '.claude/memory/known-pitfalls.md', '# Known pitfalls\n\nNone yet.\n')
    // Subfolders of memory (plugin snippets) are not memory files.
    await put('base', '.claude/memory/snippets/github-clone.md', '# Snippet\n')

    const catalogue = await buildIntelligenceCatalogue([{ layer: 'base', root: base }])

    const byPath = new Map(catalogue.artefacts.map(a => [a.path, a]))
    expect([...byPath.keys()].sort()).toEqual([
      '.claude/agents/planner.md',
      '.claude/commands/coro/job.md',
      '.claude/memory/known-pitfalls.md',
      '.claude/skills/feature-planning/SKILL.md',
    ])
    expect(byPath.get('.claude/commands/coro/job.md')).toMatchObject({ kind: 'workflow', displayName: 'Demo' })
    expect(byPath.get('.claude/agents/planner.md')).toMatchObject({ kind: 'agent', displayName: 'Planner' })
    expect(byPath.get('.claude/skills/feature-planning/SKILL.md')).toMatchObject({ kind: 'skill' })
    expect(byPath.get('.claude/memory/known-pitfalls.md')).toMatchObject({ kind: 'memory' })
    expect(catalogue.layers[0]).toMatchObject({
      layer: 'base',
      exists: true,
      writable: false,
      counts: { workflow: 1, agent: 1, skill: 1, memory: 1 },
    })
  })

  it('takes an agent description from its front matter and never from the standalone block', async () => {
    const base = await put('base', '.claude/agents/planner.md', AGENT)

    const { artefacts } = await buildIntelligenceCatalogue([{ layer: 'base', root: base }])

    expect(artefacts[0]!.description).toBe('Plans the work before any code is written.')
  })

  it('falls back to the first paragraph without quoting the standalone block', async () => {
    const base = await put(
      'base',
      '.claude/agents/bare.md',
      `# Agent: Bare\n\n${START}\nOutside the runner.\n${END}\n\nThe real summary.\n`,
    )

    const { artefacts } = await buildIntelligenceCatalogue([{ layer: 'base', root: base }])

    expect(artefacts[0]!.description).toBe('The real summary.')
  })

  it('leaves out slash commands that declare no phases', async () => {
    const base = await put('base', '.claude/commands/coro/job.md', WORKFLOW)
    await put('base', '.claude/commands/coro/hello.md', '# Hello\n\nJust a command.\n')

    const { artefacts } = await buildIntelligenceCatalogue([{ layer: 'base', root: base }])

    expect(artefacts.filter(a => a.kind === 'workflow').map(a => a.path)).toEqual(['.claude/commands/coro/job.md'])
  })

  it('ignores the pre-native folders', async () => {
    const base = await put('base', 'workflows/job/workflow.md', WORKFLOW)
    await put('base', 'agents/planner.md', AGENT)
    await put('base', 'memory/MEMORY.md', '# Memory\n')

    const { artefacts } = await buildIntelligenceCatalogue([{ layer: 'base', root: base }])

    expect(artefacts).toEqual([])
  })

  it('marks a tenant agent as overriding the base one', async () => {
    const base = await put('base', '.claude/agents/planner.md', AGENT)
    const tenant = await put('tenant', '.claude/agents/planner.md', AGENT.replace('Plans the work', 'Tenant plans'))

    const { artefacts } = await buildIntelligenceCatalogue([
      { layer: 'tenant', root: tenant },
      { layer: 'base', root: base },
    ])

    const planners = artefacts.filter(a => a.path === '.claude/agents/planner.md')
    expect(planners).toHaveLength(1)
    expect(planners[0]).toMatchObject({ layer: 'tenant', overrides: 'base' })
    expect(planners[0]!.description).toContain('Tenant plans')
  })
})
