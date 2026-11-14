// ── Prompt-file readers ───────────────────────────────────────────────────────
//
// The files the runner turns into prompts are Claude Code's native ones, so
// they carry things a model must not be told:
//
//   - YAML front matter on agents (`name`, `description`, `tools`), which
//     Claude Code needs to discover a subagent and the runner does not.
//   - The Coro-only runtime contract (`.claude/coro/RUNTIME.md`: MCP tools,
//     sandbox, checkpoints), which used to be half of `.claude/CLAUDE.md`
//     and is now a separate file so that Claude Code, which loads CLAUDE.md
//     natively, is not told to call tools it does not have.
//
// Every place that builds a prompt from the resolved intelligence directory
// reads through these helpers, so the two rules are applied the same way
// everywhere: the system prompt builder, the SDK subagent specs, the
// `run_subagent` tool and the review lenses.

import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { LAYER_FILES } from '@coro-ai/intelligence-base'

import { stripFrontMatter } from '../workflow-parser'

/** Separator the runner puts between prompt sections. */
export const PROMPT_SECTION_SEPARATOR = '\n\n---\n\n'

/** Relative path of the Coro-only runtime contract inside an intelligence dir. */
export const RUNTIME_CONTRACT_PATH = LAYER_FILES.runtimeMd

/** Relative path of the portable ambient rules inside an intelligence dir. */
export const CLAUDE_MD_PATH = LAYER_FILES.claudeMd

/** An agent or lens file as the model should see it: front matter removed. */
export function parseAgentPrompt(markdown: string): string {
  return stripFrontMatter(markdown)
}

/** Read an agent file relative to `intelligenceDir`, without its front matter. */
export async function readAgentPrompt(intelligenceDir: string, relPath: string): Promise<string> {
  return parseAgentPrompt(await fs.readFile(path.join(intelligenceDir, relPath), 'utf-8'))
}

/** Synchronous {@link readAgentPrompt} for the call sites that cannot await. */
export function readAgentPromptSync(intelligenceDir: string, relPath: string): string {
  return parseAgentPrompt(readFileSync(path.join(intelligenceDir, relPath), 'utf-8'))
}

/**
 * The Coro runtime contract for this job, or `null` when the overlay has none
 * (a partial overlay must never crash a prompt build).
 */
export async function readRuntimeContract(intelligenceDir: string): Promise<string | null> {
  try {
    const text = await fs.readFile(path.join(intelligenceDir, RUNTIME_CONTRACT_PATH), 'utf-8')
    return text.trim() ? text : null
  } catch {
    return null
  }
}

/** Synchronous {@link readRuntimeContract}. */
export function readRuntimeContractSync(intelligenceDir: string): string | null {
  try {
    const text = readFileSync(path.join(intelligenceDir, RUNTIME_CONTRACT_PATH), 'utf-8')
    return text.trim() ? text : null
  } catch {
    return null
  }
}

/** The portable ambient rules, or `null` when the overlay has none. */
export function readClaudeMdSync(intelligenceDir: string): string | null {
  try {
    return readFileSync(path.join(intelligenceDir, CLAUDE_MD_PATH), 'utf-8')
  } catch {
    return null
  }
}
