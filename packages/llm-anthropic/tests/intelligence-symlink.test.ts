import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EXPOSED_CLAUDE_ENTRIES, ensureClaudeConfigSymlink } from '../src/intelligence-symlink'

const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger

let root: string
let intelligenceDir: string
let workingDir: string

function write(rel: string, content: string): void {
  const abs = path.join(intelligenceDir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

/** A resolved overlay as the runner materialises it: the full native tree. */
function populateOverlay(): void {
  write('.claude/CLAUDE.md', '# Portable rules\n')
  write('.claude/skills/foo/SKILL.md', '---\nname: foo\ndescription: Foo.\n---\n')
  write('.claude/settings.json', '{}\n')
  write('.claude/agents/planner.md', '---\nname: planner\ndescription: Plans.\n---\n# Planner\n')
  write('.claude/commands/coro/job.md', '---\nphases: []\n---\n')
  write('.claude/memory/MEMORY.md', '# Memory\n')
  write('.claude/coro/RUNTIME.md', '# Runtime contract\n')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-symlink-'))
  intelligenceDir = path.join(root, '_intelligence')
  workingDir = path.join(root, 'work')
  fs.mkdirSync(workingDir, { recursive: true })
  vi.clearAllMocks()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('ensureClaudeConfigSymlink', () => {
  it('exposes only CLAUDE.md, skills and settings.json', () => {
    expect([...EXPOSED_CLAUDE_ENTRIES]).toEqual(['CLAUDE.md', 'skills', 'settings.json'])
  })

  it('makes .claude a real directory that links the exposed entries', () => {
    populateOverlay()

    ensureClaudeConfigSymlink(workingDir, intelligenceDir, logger)

    const claudeDir = path.join(workingDir, '.claude')
    expect(fs.lstatSync(claudeDir).isSymbolicLink()).toBe(false)
    expect(fs.lstatSync(claudeDir).isDirectory()).toBe(true)
    expect(fs.readdirSync(claudeDir).sort()).toEqual(['CLAUDE.md', 'settings.json', 'skills'])

    expect(fs.lstatSync(path.join(claudeDir, 'CLAUDE.md')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe('# Portable rules\n')
    expect(fs.readFileSync(path.join(claudeDir, 'skills', 'foo', 'SKILL.md'), 'utf8')).toContain('name: foo')
  })

  it('never exposes agents, commands, memory or the runtime contract', () => {
    populateOverlay()

    ensureClaudeConfigSymlink(workingDir, intelligenceDir, logger)

    const claudeDir = path.join(workingDir, '.claude')
    for (const hidden of ['agents', 'commands', 'memory', 'coro']) {
      expect(fs.existsSync(path.join(claudeDir, hidden))).toBe(false)
    }
  })

  it('skips entries the overlay does not have instead of leaving dangling links', () => {
    write('.claude/CLAUDE.md', '# Only rules\n')

    ensureClaudeConfigSymlink(workingDir, intelligenceDir, logger)

    expect(fs.readdirSync(path.join(workingDir, '.claude'))).toEqual(['CLAUDE.md'])
  })

  it('is idempotent across phases and follows overlay changes', () => {
    populateOverlay()
    ensureClaudeConfigSymlink(workingDir, intelligenceDir, logger)
    ensureClaudeConfigSymlink(workingDir, intelligenceDir, logger)

    const claudeDir = path.join(workingDir, '.claude')
    expect(fs.readdirSync(claudeDir).sort()).toEqual(['CLAUDE.md', 'settings.json', 'skills'])

    // The skills folder disappears from the overlay: its link must go too.
    fs.rmSync(path.join(intelligenceDir, '.claude', 'skills'), { recursive: true, force: true })
    ensureClaudeConfigSymlink(workingDir, intelligenceDir, logger)

    expect(fs.readdirSync(claudeDir).sort()).toEqual(['CLAUDE.md', 'settings.json'])
  })

  it('replaces an older whole-directory symlink with the selective directory', () => {
    populateOverlay()
    fs.symlinkSync(path.join(intelligenceDir, '.claude'), path.join(workingDir, '.claude'), 'dir')
    // Through the old link the agents folder was visible.
    expect(fs.existsSync(path.join(workingDir, '.claude', 'agents'))).toBe(true)

    ensureClaudeConfigSymlink(workingDir, intelligenceDir, logger)

    const claudeDir = path.join(workingDir, '.claude')
    expect(fs.lstatSync(claudeDir).isSymbolicLink()).toBe(false)
    expect(fs.existsSync(path.join(claudeDir, 'agents'))).toBe(false)
    expect(fs.existsSync(path.join(claudeDir, 'CLAUDE.md'))).toBe(true)
    // The overlay itself must survive the replacement.
    expect(fs.existsSync(path.join(intelligenceDir, '.claude', 'agents', 'planner.md'))).toBe(true)
  })
})
