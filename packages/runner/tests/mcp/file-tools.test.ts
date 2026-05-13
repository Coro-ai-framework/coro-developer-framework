import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { createMcpToolHandlers } from '../../src/mcp-handlers'
import { makeMockToolContext } from './fixtures'
import type { ToolContext } from '../../src/tools/types'
import type { PhaseSignals } from '../../src/tools/types'

/**
 * Phase 4 of the multi-AI plan: provider-agnostic file/skill MCP tools.
 *
 * These tests use the REAL `fs/promises` (no module mock) so they
 * actually exercise the path-traversal guards, the `file_edit`
 * uniqueness check, and `read_skill`'s overlay lookup.
 */

function parseJson(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return { ok: !result.isError, raw: result.content[0]?.text, parsed: result.isError ? undefined : JSON.parse(result.content[0]!.text) }
}

let tmpRoot: string
let workingDir: string
let intelDir: string
let ctx: ToolContext
let signals: PhaseSignals
let h: ReturnType<typeof createMcpToolHandlers>

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'coro-file-tools-'))
  const baseWorking = path.join(tmpRoot, 'working')
  workingDir = path.join(baseWorking, 'job-mcp-test')
  intelDir = path.join(tmpRoot, 'intel')
  await fs.mkdir(workingDir, { recursive: true })
  await fs.mkdir(intelDir, { recursive: true })

  ctx = makeMockToolContext({
    settings: {
      paths: { coroIntelligenceDir: intelDir, workingDir: baseWorking },
    } as ToolContext['settings'],
    jobIntelligenceDir: intelDir,
  })

  signals = {} as PhaseSignals
  h = createMcpToolHandlers(ctx, signals)
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('file_read', () => {
  it('reads a file inside the per-job working dir', async () => {
    await fs.writeFile(path.join(workingDir, 'hello.txt'), 'hi there')
    const r = parseJson(await h.file_read({ path: 'hello.txt' }))
    expect(r.ok).toBe(true)
    expect(r.parsed).toEqual({ path: 'hello.txt', content: 'hi there' })
  })

  it('rejects path traversal escapes', async () => {
    const r = parseJson(await h.file_read({ path: '../../etc/passwd' }))
    expect(r.ok).toBe(false)
    expect(r.raw).toMatch(/escapes working dir/)
  })

  it('rejects absolute paths that point outside the working dir', async () => {
    const outside = path.join(tmpRoot, 'outside.txt')
    await fs.writeFile(outside, 'secret')
    const r = parseJson(await h.file_read({ path: outside }))
    expect(r.ok).toBe(false)
  })
})

describe('file_write', () => {
  it('writes a file and creates parent directories', async () => {
    const r = parseJson(await h.file_write({ path: 'a/b/c.txt', content: 'hello' }))
    expect(r.ok).toBe(true)
    const written = await fs.readFile(path.join(workingDir, 'a/b/c.txt'), 'utf8')
    expect(written).toBe('hello')
  })

  it('rejects writes that escape the working dir', async () => {
    const r = parseJson(await h.file_write({ path: '../escape.txt', content: 'no' }))
    expect(r.ok).toBe(false)
    expect(r.raw).toMatch(/escapes working dir/)
  })
})

describe('file_edit', () => {
  it('replaces the unique occurrence of oldStr', async () => {
    await fs.writeFile(path.join(workingDir, 'f.txt'), 'before MIDDLE after')
    const r = parseJson(await h.file_edit({ path: 'f.txt', oldStr: 'MIDDLE', newStr: 'CENTER' }))
    expect(r.ok).toBe(true)
    expect(await fs.readFile(path.join(workingDir, 'f.txt'), 'utf8')).toBe('before CENTER after')
  })

  it('errors when oldStr matches multiple times', async () => {
    await fs.writeFile(path.join(workingDir, 'f.txt'), 'foo foo')
    const r = parseJson(await h.file_edit({ path: 'f.txt', oldStr: 'foo', newStr: 'bar' }))
    expect(r.ok).toBe(false)
    expect(r.raw).toMatch(/matches 2 times/)
  })

  it('errors when oldStr is missing', async () => {
    await fs.writeFile(path.join(workingDir, 'f.txt'), 'abc')
    const r = parseJson(await h.file_edit({ path: 'f.txt', oldStr: 'xyz', newStr: 'q' }))
    expect(r.ok).toBe(false)
    expect(r.raw).toMatch(/not found/)
  })
})

describe('file_glob', () => {
  it('finds files matching a glob pattern', async () => {
    await fs.mkdir(path.join(workingDir, 'src'), { recursive: true })
    await fs.writeFile(path.join(workingDir, 'src/a.ts'), '')
    await fs.writeFile(path.join(workingDir, 'src/b.ts'), '')
    await fs.writeFile(path.join(workingDir, 'src/c.js'), '')
    const r = parseJson(await h.file_glob({ pattern: 'src/*.ts' }))
    expect(r.ok).toBe(true)
    expect((r.parsed as { matches: string[] }).matches.sort()).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('supports recursive ** patterns', async () => {
    await fs.mkdir(path.join(workingDir, 'a/b/c'), { recursive: true })
    await fs.writeFile(path.join(workingDir, 'a/b/c/deep.md'), '')
    await fs.writeFile(path.join(workingDir, 'top.md'), '')
    const r = parseJson(await h.file_glob({ pattern: '**/*.md' }))
    expect((r.parsed as { matches: string[] }).matches.sort()).toEqual(['a/b/c/deep.md', 'top.md'])
  })
})

describe('file_grep', () => {
  it('finds literal substring matches across files', async () => {
    await fs.writeFile(path.join(workingDir, 'a.txt'), 'hello world\nhello again')
    await fs.writeFile(path.join(workingDir, 'b.txt'), 'no match here')
    const r = parseJson(await h.file_grep({ pattern: 'hello' }))
    expect(r.ok).toBe(true)
    const hits = (r.parsed as { hits: { path: string; line: number }[] }).hits
    expect(hits).toHaveLength(2)
    expect(hits.every(hit => hit.path === 'a.txt')).toBe(true)
  })

  it('supports regex matches when isRegex=true', async () => {
    await fs.writeFile(path.join(workingDir, 'a.txt'), 'foo123\nbar\nfoo456')
    const r = parseJson(await h.file_grep({ pattern: '^foo\\d+$', isRegex: true }))
    const hits = (r.parsed as { hits: { line: number }[] }).hits
    expect(hits.map(h => h.line)).toEqual([1, 3])
  })
})

describe('read_skill', () => {
  it('loads SKILL.md from the materialised intelligence overlay', async () => {
    const skillDir = path.join(intelDir, '.claude/skills/feature-planning')
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Feature Planning\n\nGuidance here.')
    const r = parseJson(await h.read_skill({ name: 'feature-planning' }))
    expect(r.ok).toBe(true)
    expect((r.parsed as { content: string }).content).toMatch(/Feature Planning/)
  })

  it('errors for an unknown skill', async () => {
    const r = parseJson(await h.read_skill({ name: 'no-such-skill' }))
    expect(r.ok).toBe(false)
    expect(r.raw).toMatch(/not found/)
  })

  it('rejects skill names with path separators', async () => {
    const r = parseJson(await h.read_skill({ name: '../escape' }))
    expect(r.ok).toBe(false)
    expect(r.raw).toMatch(/invalid skill name/)
  })
})
