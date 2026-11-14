import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { discoverWorkflows } from '../../src/workflow-discovery'

const START = '<!-- standalone:start -->'
const END = '<!-- standalone:end -->'

const PHASES = `initial_phase: planning
initial_status: queued
phases:
  - name: planning
    agent: .claude/agents/planner.md
    model: planning
    status: planning
  - name: coding
    agent: .claude/agents/coder.md
    model: coding
    status: coding
    interactive_checkpoint: true`

function workflow(extraFrontMatter = '', body = '# Workflow: Demo\n\nRuns the demo.'): string {
  return `---\n${extraFrontMatter ? extraFrontMatter + '\n' : ''}${PHASES}\n---\n\n${body}\n`
}

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'coro-discovery-'))
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

describe('discoverWorkflows (native layout)', () => {
  it('finds workflows at .claude/commands/coro/<id>.md and derives the id from the file name', async () => {
    const base = await put('base', '.claude/commands/coro/job.md', workflow())

    const found = await discoverWorkflows([{ layer: 'base', root: base }])

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      id: 'job',
      workflowPath: '.claude/commands/coro/job.md',
      name: 'Demo',
      description: 'Runs the demo.',
      kind: 'job',
      layer: 'base',
      initialPhase: 'planning',
    })
    expect(found[0]!.phases.map(p => p.name)).toEqual(['planning', 'coding'])
    expect(found[0]!.phases[1]).toMatchObject({ agent: '.claude/agents/coder.md', interactiveCheckpoint: true })
  })

  it('prefers display_name and kind from the front matter', async () => {
    const base = await put(
      'base',
      '.claude/commands/coro/self-update.md',
      workflow('display_name: Self update\nkind: internal'),
    )

    const [wf] = await discoverWorkflows([{ layer: 'base', root: base }])

    expect(wf).toMatchObject({ id: 'self-update', name: 'Self update', kind: 'internal' })
  })

  it('skips slash commands that declare no phases', async () => {
    const base = await put('base', '.claude/commands/coro/job.md', workflow())
    await put('base', '.claude/commands/coro/hello.md', '---\nargument-hint: "<name>"\n---\n\n# Hello\n\nSay hi.\n')
    await put('base', '.claude/commands/coro/plain.md', '# Plain command with no front matter\n')

    const found = await discoverWorkflows([{ layer: 'base', root: base }])

    expect(found.map(wf => wf.id)).toEqual(['job'])
  })

  it('ignores commands outside the coro namespace folder', async () => {
    const base = await put('base', '.claude/commands/job.md', workflow())

    expect(await discoverWorkflows([{ layer: 'base', root: base }])).toEqual([])
  })

  it('ignores the pre-native workflows/<id>/workflow.md layout', async () => {
    const base = await put('base', 'workflows/job/workflow.md', workflow())

    expect(await discoverWorkflows([{ layer: 'base', root: base }])).toEqual([])
  })

  it('never quotes the standalone block when it falls back to the first paragraph', async () => {
    const body = `# Workflow: Demo\n\n${START}\n## Run this workflow in Claude Code\n\nRequest: $ARGUMENTS\n${END}\n\nThe real description.`
    const base = await put('base', '.claude/commands/coro/job.md', workflow('', body))

    const [wf] = await discoverWorkflows([{ layer: 'base', root: base }])

    expect(wf!.description).toBe('The real description.')
    expect(wf!.description).not.toContain('Claude Code')
  })

  it('lets a tenant workflow override the base one and records what it shadows', async () => {
    const base = await put('base', '.claude/commands/coro/job.md', workflow('', '# Workflow: Base job\n\nBase.'))
    const tenant = await put('tenant', '.claude/commands/coro/job.md', workflow('', '# Workflow: Tenant job\n\nTenant.'))

    const found = await discoverWorkflows([
      { layer: 'tenant', root: tenant },
      { layer: 'base', root: base },
    ])

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ name: 'Tenant job', layer: 'tenant', overrides: 'base' })
  })

  it('returns an empty list for a root without any commands folder', async () => {
    await fs.mkdir(path.join(root, 'empty'), { recursive: true })

    expect(await discoverWorkflows([{ layer: 'base', root: path.join(root, 'empty') }])).toEqual([])
  })
})
