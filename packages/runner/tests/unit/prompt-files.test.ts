import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CLAUDE_MD_PATH,
  PROMPT_SECTION_SEPARATOR,
  RUNTIME_CONTRACT_PATH,
  parseAgentPrompt,
  readAgentPrompt,
  readAgentPromptSync,
  readClaudeMdSync,
  readRuntimeContract,
  readRuntimeContractSync,
} from '../../src/intelligence/prompt-files'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coro-prompt-files-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function put(rel: string, content: string): Promise<void> {
  const abs = path.join(dir, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content)
}

const AGENT = '---\nname: planner\ndescription: Plans the work.\ntools: Read, Grep\n---\n\n# Agent: Planner\n\nStep 1.\n'

describe('well-known paths', () => {
  it('point into the native .claude/ tree', () => {
    expect(RUNTIME_CONTRACT_PATH).toBe('.claude/coro/RUNTIME.md')
    expect(CLAUDE_MD_PATH).toBe('.claude/CLAUDE.md')
  })

  it('keeps one section separator for every prompt builder', () => {
    expect(PROMPT_SECTION_SEPARATOR).toBe('\n\n---\n\n')
  })
})

describe('parseAgentPrompt', () => {
  it('removes the Claude Code front matter', () => {
    const out = parseAgentPrompt(AGENT)
    expect(out).toContain('# Agent: Planner')
    expect(out).not.toContain('description: Plans the work.')
    expect(out).not.toContain('tools: Read, Grep')
    expect(out.startsWith('---')).toBe(false)
  })

  it('returns a file without front matter unchanged', () => {
    expect(parseAgentPrompt('# Agent: Plain\n\nBody.')).toContain('# Agent: Plain')
  })
})

describe('readAgentPrompt / readAgentPromptSync', () => {
  it('reads an agent relative to the intelligence dir and drops the front matter', async () => {
    await put('.claude/agents/planner.md', AGENT)

    for (const text of [
      await readAgentPrompt(dir, '.claude/agents/planner.md'),
      readAgentPromptSync(dir, '.claude/agents/planner.md'),
    ]) {
      expect(text).toContain('Step 1.')
      expect(text).not.toContain('name: planner')
    }
  })

  it('throws when the agent does not exist (callers decide how to degrade)', async () => {
    await expect(readAgentPrompt(dir, '.claude/agents/missing.md')).rejects.toThrow()
    expect(() => readAgentPromptSync(dir, '.claude/agents/missing.md')).toThrow()
  })
})

describe('readRuntimeContract / readRuntimeContractSync', () => {
  it('returns the contract text', async () => {
    await put('.claude/coro/RUNTIME.md', '# Runtime contract\n\nUse mcp__coro__ tools.\n')

    expect(await readRuntimeContract(dir)).toContain('Use mcp__coro__ tools.')
    expect(readRuntimeContractSync(dir)).toContain('Use mcp__coro__ tools.')
  })

  it('returns null for a missing or blank file, never throws', async () => {
    expect(await readRuntimeContract(dir)).toBeNull()
    expect(readRuntimeContractSync(dir)).toBeNull()

    await put('.claude/coro/RUNTIME.md', '   \n\n')
    expect(await readRuntimeContract(dir)).toBeNull()
    expect(readRuntimeContractSync(dir)).toBeNull()
  })
})

describe('readClaudeMdSync', () => {
  it('returns the portable rules or null', async () => {
    expect(readClaudeMdSync(dir)).toBeNull()
    await put('.claude/CLAUDE.md', '# Portable rules\n')
    expect(readClaudeMdSync(dir)).toContain('# Portable rules')
  })
})
