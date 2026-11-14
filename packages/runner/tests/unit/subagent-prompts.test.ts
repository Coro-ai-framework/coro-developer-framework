import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildExecutorSubagentSpecs } from '../../src/jobs/runner'
import { runOneLens } from '../../src/reviews/lens-runner'
import type { Settings } from '../../src/config/settings'

// Every subagent prompt is built from the Claude Code native files, so each
// one has to drop the agent's front matter and put the Coro runtime contract
// first. The portable CLAUDE.md is only added when the executor cannot load
// it itself. These tests cover the three builders that are not the main
// system prompt: SDK subagent specs, and review lenses.

const AGENT = '---\nname: code-reviewer\ndescription: Reviews a diff.\ntools: Read, Grep\n---\n\n# Agent: Code Reviewer\n\nReview the diff.\n'
const RUNTIME = '# Coro runtime contract\n\nUse mcp__coro__ tools.\n'
const CLAUDE_MD = '# Portable rules\n\nFollow the conventions.\n'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coro-subagent-prompts-'))
  await put('.claude/agents/code-reviewer.md', AGENT)
  await put('.claude/coro/RUNTIME.md', RUNTIME)
  await put('.claude/CLAUDE.md', CLAUDE_MD)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function put(rel: string, content: string): Promise<void> {
  const abs = path.join(dir, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content)
}

const settings = { llm: { aliases: {} } } as unknown as Settings

describe('buildExecutorSubagentSpecs', () => {
  const subagents = [{ name: 'code-reviewer', agent: '.claude/agents/code-reviewer.md' }]

  it('starts with the runtime contract and drops the agent front matter', () => {
    const [spec] = buildExecutorSubagentSpecs(subagents, dir, settings, { prependClaudeMd: false })

    expect(spec!.systemPrompt.startsWith('# Coro runtime contract')).toBe(true)
    expect(spec!.systemPrompt).toContain('# Agent: Code Reviewer')
    expect(spec!.systemPrompt).toContain('Review the diff.')
    expect(spec!.systemPrompt).not.toContain('description: Reviews a diff.')
    expect(spec!.systemPrompt).not.toContain('Portable rules')
  })

  it('adds CLAUDE.md between the contract and the agent for executors without native walk-up', () => {
    const [spec] = buildExecutorSubagentSpecs(subagents, dir, settings, { prependClaudeMd: true })

    const prompt = spec!.systemPrompt
    expect(prompt.indexOf('Coro runtime contract')).toBeLessThan(prompt.indexOf('Portable rules'))
    expect(prompt.indexOf('Portable rules')).toBeLessThan(prompt.indexOf('# Agent: Code Reviewer'))
  })

  it('falls back to a short prompt when the agent file is missing, still under the contract', () => {
    const [spec] = buildExecutorSubagentSpecs(
      [{ name: 'ghost', agent: '.claude/agents/ghost.md' }],
      dir,
      settings,
      { prependClaudeMd: false },
    )

    expect(spec!.systemPrompt).toContain('You are the ghost subagent.')
    expect(spec!.systemPrompt.startsWith('# Coro runtime contract')).toBe(true)
  })

  it('works on an overlay with no runtime contract', async () => {
    await fs.rm(path.join(dir, '.claude', 'coro'), { recursive: true, force: true })

    const [spec] = buildExecutorSubagentSpecs(subagents, dir, settings, { prependClaudeMd: false })

    expect(spec!.systemPrompt.startsWith('# Agent: Code Reviewer')).toBe(true)
  })
})

describe('runOneLens system prompt', () => {
  const LENS_JSON = '```json\n{"findings": [], "sourcesUsed": []}\n```'

  function makeCtx(captured: { prompts: string[] }) {
    const executor = {
      manifest: { id: 'fake' },
      capabilities: { supportsNativeFileTools: true, supportsNativeWebTools: true },
      runSubagent: vi.fn(async (req: { systemPrompt: string }) => {
        captured.prompts.push(req.systemPrompt)
        return { output: LENS_JSON, usage: { inputTokens: 1, outputTokens: 1, totalCostUsd: 0 } }
      }),
    }
    return {
      settings: { llm: { aliases: {} } },
      plugins: { resolveExecutor: () => executor },
      currentPhase: {
        executor,
        jobIntelligenceDir: dir,
        workingDir: dir,
        pluginMcpServers: {},
        mcpServer: {},
        hookPolicy: {},
      },
    } as never
  }

  const lens = { name: 'correctness', agent: '.claude/agents/code-reviewer.md' }
  const policy = { mcpRoles: {} }

  it('puts the runtime contract in front of a lens on the Coro branch (projectContext: load)', async () => {
    const captured = { prompts: [] as string[] }

    await runOneLens(makeCtx(captured), lens, 'review it', policy, { projectContext: 'load' })

    const prompt = captured.prompts[0]!
    expect(prompt.startsWith('# Coro runtime contract')).toBe(true)
    expect(prompt).toContain('# Agent: Code Reviewer')
    expect(prompt).not.toContain('description: Reviews a diff.')
  })

  it('leaves a pull-request lens (projectContext: skip) without the contract, front matter still removed', async () => {
    const captured = { prompts: [] as string[] }

    await runOneLens(makeCtx(captured), lens, 'review it', policy, { projectContext: 'skip' })
    await runOneLens(makeCtx(captured), lens, 'review it', policy)

    for (const prompt of captured.prompts) {
      expect(prompt).not.toContain('Coro runtime contract')
      expect(prompt).not.toContain('mcp__coro__')
      expect(prompt.startsWith('# Agent: Code Reviewer')).toBe(true)
      expect(prompt).not.toContain('description: Reviews a diff.')
    }
  })
})
