import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { applyLayer, mergeModeFor } from '../../src/intelligence/merge'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'coro-merge-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<string> {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content)
  return abs
}

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), 'utf8')
}

describe('mergeModeFor', () => {
  it('uses append for .claude/CLAUDE.md', () => {
    expect(mergeModeFor('.claude/CLAUDE.md')).toBe('append')
  })

  it('uses append for memory/* files', () => {
    expect(mergeModeFor('memory/MEMORY.md')).toBe('append')
    expect(mergeModeFor('memory/proposals/2025-01-01.md')).toBe('append')
  })

  it('uses replace for agents, workflows, skills', () => {
    expect(mergeModeFor('agents/planner.md')).toBe('replace')
    expect(mergeModeFor('workflows/job/workflow.md')).toBe('replace')
    expect(mergeModeFor('.claude/skills/foo/SKILL.md')).toBe('replace')
  })

  it('uses replace for unknown paths by default', () => {
    expect(mergeModeFor('something/else.md')).toBe('replace')
    expect(mergeModeFor('.claude/settings.json')).toBe('replace')
  })

  it('treats POSIX and platform separators identically', () => {
    expect(mergeModeFor(path.join('memory', 'foo.md'))).toBe('append')
    expect(mergeModeFor(path.join('agents', 'planner.md'))).toBe('replace')
  })
})

describe('applyLayer (replace mode)', () => {
  it('copies plain files into the destination', async () => {
    const src = path.join(root, 'src')
    const dest = path.join(root, 'dest')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'agent.md'), 'planner content')

    const result = await applyLayer({ srcRoot: src, destRoot: dest, layerName: 'base' })
    expect(result.filesApplied).toBe(1)
    const out = await fs.readFile(path.join(dest, 'agent.md'), 'utf8')
    expect(out).toBe('planner content')
  })

  it('overwrites a destination file from a higher layer', async () => {
    await write('base/agents/planner.md', '# Base planner\n')
    await write('tenant/agents/planner.md', '# Tenant planner\n')
    const dest = path.join(root, 'dest')

    await applyLayer({ srcRoot: path.join(root, 'base'), destRoot: dest, layerName: 'base' })
    await applyLayer({ srcRoot: path.join(root, 'tenant'), destRoot: dest, layerName: 'tenant' })

    const out = await fs.readFile(path.join(dest, 'agents', 'planner.md'), 'utf8')
    expect(out).toBe('# Tenant planner\n')
    expect(out).not.toContain('Base planner')
  })

  it('skips .DS_Store at any depth', async () => {
    await write('src/.DS_Store', 'noise')
    await write('src/agents/.DS_Store', 'more noise')
    await write('src/agents/planner.md', 'content')
    const dest = path.join(root, 'dest')

    const result = await applyLayer({ srcRoot: path.join(root, 'src'), destRoot: dest, layerName: 'base' })
    expect(result.filesApplied).toBe(1)
    await expect(fs.access(path.join(dest, '.DS_Store'))).rejects.toThrow()
    await expect(fs.access(path.join(dest, 'agents', '.DS_Store'))).rejects.toThrow()
  })

  it('returns filesApplied=0 and does not crash when src does not exist', async () => {
    const dest = path.join(root, 'dest')
    const result = await applyLayer({
      srcRoot: path.join(root, 'missing'),
      destRoot: dest,
      layerName: 'tenant',
    })
    expect(result.filesApplied).toBe(0)
  })
})

describe('applyLayer (append mode)', () => {
  it('appends CLAUDE.md from a higher layer with a banner', async () => {
    await write('base/.claude/CLAUDE.md', '# Base CLAUDE\n\nbase guidance.')
    await write('tenant/.claude/CLAUDE.md', '# Tenant CLAUDE\n\ntenant guidance.')
    const dest = path.join(root, 'dest')

    await applyLayer({ srcRoot: path.join(root, 'base'), destRoot: dest, layerName: 'base' })
    await applyLayer({ srcRoot: path.join(root, 'tenant'), destRoot: dest, layerName: 'tenant' })

    const out = await fs.readFile(path.join(dest, '.claude', 'CLAUDE.md'), 'utf8')
    expect(out).toContain('# Base CLAUDE')
    expect(out).toContain('# Tenant CLAUDE')
    expect(out).toContain('coro layer: base')
    expect(out).toContain('coro layer: tenant')
    // Tenant content must come after base content (provenance ordering).
    expect(out.indexOf('Base CLAUDE')).toBeLessThan(out.indexOf('Tenant CLAUDE'))
  })

  it('appends memory/*.md from successive layers', async () => {
    await write('base/memory/MEMORY.md', '# Base index\n- entry A')
    await write('tenant/memory/MEMORY.md', '# Tenant additions\n- entry B')
    await write('repo/memory/MEMORY.md', '# Repo additions\n- entry C')
    const dest = path.join(root, 'dest')

    await applyLayer({ srcRoot: path.join(root, 'base'), destRoot: dest, layerName: 'base' })
    await applyLayer({ srcRoot: path.join(root, 'tenant'), destRoot: dest, layerName: 'tenant' })
    await applyLayer({ srcRoot: path.join(root, 'repo'), destRoot: dest, layerName: 'repo' })

    const out = await fs.readFile(path.join(dest, 'memory', 'MEMORY.md'), 'utf8')
    expect(out).toContain('entry A')
    expect(out).toContain('entry B')
    expect(out).toContain('entry C')
    expect(out.indexOf('entry A')).toBeLessThan(out.indexOf('entry B'))
    expect(out.indexOf('entry B')).toBeLessThan(out.indexOf('entry C'))
  })

  it('writes a banner even when only one layer contributes a CLAUDE.md', async () => {
    await write('base/.claude/CLAUDE.md', '# Base only')
    const dest = path.join(root, 'dest')

    await applyLayer({ srcRoot: path.join(root, 'base'), destRoot: dest, layerName: 'base' })

    const out = await fs.readFile(path.join(dest, '.claude', 'CLAUDE.md'), 'utf8')
    expect(out).toContain('coro layer: base')
    expect(out).toContain('# Base only')
  })

  it('keeps non-overlapping memory files from different layers', async () => {
    await write('base/memory/known-pitfalls.md', '## base pitfalls')
    await write('tenant/memory/successful-patterns.md', '## tenant patterns')
    const dest = path.join(root, 'dest')

    await applyLayer({ srcRoot: path.join(root, 'base'), destRoot: dest, layerName: 'base' })
    await applyLayer({ srcRoot: path.join(root, 'tenant'), destRoot: dest, layerName: 'tenant' })

    const pit = await fs.readFile(path.join(dest, 'memory', 'known-pitfalls.md'), 'utf8')
    const pat = await fs.readFile(path.join(dest, 'memory', 'successful-patterns.md'), 'utf8')
    expect(pit).toContain('base pitfalls')
    expect(pat).toContain('tenant patterns')
  })
})

describe('applyLayer (sanity)', () => {
  it('writes destination directories that did not previously exist', async () => {
    await write('src/deeply/nested/dir/file.md', 'x')
    const dest = path.join(root, 'dest')

    await applyLayer({ srcRoot: path.join(root, 'src'), destRoot: dest, layerName: 'base' })
    const out = await read(path.relative(root, path.join(dest, 'deeply', 'nested', 'dir', 'file.md')))
    expect(out).toBe('x')
  })
})
