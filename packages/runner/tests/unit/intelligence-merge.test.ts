import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  applyLayer,
  mergeModeFor,
  stripStandaloneBlocks,
  stripStandaloneBlocksInTree,
} from '../../src/intelligence/merge'

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

  it('uses append for the Coro runtime contract', () => {
    expect(mergeModeFor('.claude/coro/RUNTIME.md')).toBe('append')
  })

  it('uses append for .claude/memory/* files', () => {
    expect(mergeModeFor('.claude/memory/MEMORY.md')).toBe('append')
    expect(mergeModeFor('.claude/memory/snippets/github-clone.md')).toBe('append')
    expect(mergeModeFor('.claude/memory/proposals/2025-01-01.md')).toBe('append')
  })

  it('no longer treats the pre-native memory/ folder as memory', () => {
    expect(mergeModeFor('memory/MEMORY.md')).toBe('replace')
  })

  it('uses replace for agents, workflows, skills', () => {
    expect(mergeModeFor('.claude/agents/planner.md')).toBe('replace')
    expect(mergeModeFor('.claude/commands/coro/job.md')).toBe('replace')
    expect(mergeModeFor('.claude/skills/foo/SKILL.md')).toBe('replace')
  })

  it('uses replace for unknown paths by default', () => {
    expect(mergeModeFor('something/else.md')).toBe('replace')
    expect(mergeModeFor('.claude/settings.json')).toBe('replace')
  })

  it('treats POSIX and platform separators identically', () => {
    expect(mergeModeFor(path.join('.claude', 'memory', 'foo.md'))).toBe('append')
    expect(mergeModeFor(path.join('.claude', 'agents', 'planner.md'))).toBe('replace')
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
    await write('base/.claude/agents/planner.md', '# Base planner\n')
    await write('tenant/.claude/agents/planner.md', '# Tenant planner\n')
    const dest = path.join(root, 'dest')

    await applyLayer({ srcRoot: path.join(root, 'base'), destRoot: dest, layerName: 'base' })
    await applyLayer({ srcRoot: path.join(root, 'tenant'), destRoot: dest, layerName: 'tenant' })

    const out = await fs.readFile(path.join(dest, '.claude', 'agents', 'planner.md'), 'utf8')
    expect(out).toBe('# Tenant planner\n')
    expect(out).not.toContain('Base planner')
  })

  it('skips .DS_Store at any depth', async () => {
    await write('src/.DS_Store', 'noise')
    await write('src/.claude/agents/.DS_Store', 'more noise')
    await write('src/.claude/agents/planner.md', 'content')
    const dest = path.join(root, 'dest')

    const result = await applyLayer({ srcRoot: path.join(root, 'src'), destRoot: dest, layerName: 'base' })
    expect(result.filesApplied).toBe(1)
    await expect(fs.access(path.join(dest, '.DS_Store'))).rejects.toThrow()
    await expect(fs.access(path.join(dest, '.claude', 'agents', '.DS_Store'))).rejects.toThrow()
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

  it('appends .claude/memory/*.md from successive layers', async () => {
    await write('base/.claude/memory/MEMORY.md', '# Base index\n- entry A')
    await write('tenant/.claude/memory/MEMORY.md', '# Tenant additions\n- entry B')
    await write('repo/.claude/memory/MEMORY.md', '# Repo additions\n- entry C')
    const dest = path.join(root, 'dest')

    await applyLayer({ srcRoot: path.join(root, 'base'), destRoot: dest, layerName: 'base' })
    await applyLayer({ srcRoot: path.join(root, 'tenant'), destRoot: dest, layerName: 'tenant' })
    await applyLayer({ srcRoot: path.join(root, 'repo'), destRoot: dest, layerName: 'repo' })

    const out = await fs.readFile(path.join(dest, '.claude', 'memory', 'MEMORY.md'), 'utf8')
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
    await write('base/.claude/memory/known-pitfalls.md', '## base pitfalls')
    await write('tenant/.claude/memory/successful-patterns.md', '## tenant patterns')
    const dest = path.join(root, 'dest')

    await applyLayer({ srcRoot: path.join(root, 'base'), destRoot: dest, layerName: 'base' })
    await applyLayer({ srcRoot: path.join(root, 'tenant'), destRoot: dest, layerName: 'tenant' })

    const pit = await fs.readFile(path.join(dest, '.claude', 'memory', 'known-pitfalls.md'), 'utf8')
    const pat = await fs.readFile(path.join(dest, '.claude', 'memory', 'successful-patterns.md'), 'utf8')
    expect(pit).toContain('base pitfalls')
    expect(pat).toContain('tenant patterns')
  })

  it('appends the runtime contract from a higher layer with a banner', async () => {
    await write('base/.claude/coro/RUNTIME.md', '# Base runtime\n')
    await write('tenant/.claude/coro/RUNTIME.md', '# Tenant runtime\n')
    const dest = path.join(root, 'dest')

    await applyLayer({ srcRoot: path.join(root, 'base'), destRoot: dest, layerName: 'base' })
    await applyLayer({ srcRoot: path.join(root, 'tenant'), destRoot: dest, layerName: 'tenant' })

    const out = await read('dest/.claude/coro/RUNTIME.md')
    expect(out).toContain('# Base runtime')
    expect(out).toContain('# Tenant runtime')
    expect(out.indexOf('Base runtime')).toBeLessThan(out.indexOf('Tenant runtime'))
  })
})

const START = '<!-- standalone:start -->'
const END = '<!-- standalone:end -->'

describe('stripStandaloneBlocks', () => {
  it('removes a fenced block and the blank lines after it', () => {
    const md = `Intro.\n\n${START}\n## Only in Claude Code\n\nText.\n${END}\n\n## Kept\n`
    expect(stripStandaloneBlocks(md)).toBe('Intro.\n\n## Kept\n')
  })

  it('removes several blocks in one document', () => {
    const md = `A\n\n${START}\nx\n${END}\n\nB\n\n${START}\ny\n${END}\n\nC\n`
    expect(stripStandaloneBlocks(md)).toBe('A\n\nB\n\nC\n')
  })

  it('removes a block directly after front matter and an H1', () => {
    const fm = `---\nname: coder\n---\n\n# Agent: Coder\n\n${START}\nOutside the runner.\n${END}\n\n## Role\n`
    expect(stripStandaloneBlocks(fm)).toBe('---\nname: coder\n---\n\n# Agent: Coder\n\n## Role\n')
  })

  it('leaves a document with no block untouched', () => {
    const md = '# Title\n\nNothing fenced here.\n'
    expect(stripStandaloneBlocks(md)).toBe(md)
  })

  it('does not treat a mid-line mention as a fence', () => {
    const md = `Prose that names ${START} and ${END} inline must survive.\n\nMore.\n`
    expect(stripStandaloneBlocks(md)).toBe(md)
  })

  it('leaves a start marker with no end marker alone', () => {
    const md = `Before\n\n${START}\nnever closed\n`
    expect(stripStandaloneBlocks(md)).toBe(md)
  })

  it('handles CRLF line endings', () => {
    const md = `Before\r\n\r\n${START}\r\nx\r\n${END}\r\n\r\nAfter\r\n`
    expect(stripStandaloneBlocks(md)).toBe('Before\r\n\r\nAfter\r\n')
  })
})

describe('stripStandaloneBlocksInTree', () => {
  it('rewrites only markdown files that contain a block, at any depth', async () => {
    await write('tree/.claude/CLAUDE.md', `# Rules\n\n${START}\nstandalone\n${END}\n\n## After\n`)
    await write('tree/.claude/agents/coder.md', '# Coder\n')
    await write('tree/.claude/skills/x/SKILL.md', `---\nname: x\n---\n\n${START}\nhelp\n${END}\n\nBody\n`)
    await write('tree/notes.txt', `${START}\nnot markdown\n${END}\n`)

    const changed = await stripStandaloneBlocksInTree(path.join(root, 'tree'))

    expect(changed).toBe(2)
    expect(await read('tree/.claude/CLAUDE.md')).toBe('# Rules\n\n## After\n')
    expect(await read('tree/.claude/agents/coder.md')).toBe('# Coder\n')
    expect(await read('tree/.claude/skills/x/SKILL.md')).toBe('---\nname: x\n---\n\nBody\n')
    expect(await read('tree/notes.txt')).toContain('not markdown')
  })

  it('returns 0 for a missing directory', async () => {
    expect(await stripStandaloneBlocksInTree(path.join(root, 'nope'))).toBe(0)
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
