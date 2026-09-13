/**
 * Lint test — keeps the runner core provider-neutral.
 *
 * No source under `packages/runner/src/**` may statically import
 * `@anthropic-ai/claude-agent-sdk`, `@coro-ai/llm-anthropic`, or
 * `@coro-ai/llm-openai`. Built-in executors are loaded only from
 * `plugins/builtin/index.ts` via `await import(...)`.
 *
 * `jobs/runner.ts` must not dynamically import an LLM package either —
 * error classification goes through {@link PhaseExecutorRuntime.classifyPhaseError}.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const FORBIDDEN_IMPORTS = [
  '@anthropic-ai/claude-agent-sdk',
  '@coro-ai/llm-anthropic',
  '@coro-ai/llm-openai',
] as const

const RUNNER_ROOT = path.resolve(__dirname, '../../src')
const DYNAMIC_IMPORT_ALLOWLIST = new Set([
  path.normalize('plugins/builtin/index.ts'),
])

function collectFiles(target: string): string[] {
  const stat = statSync(target)
  if (stat.isFile()) return target.endsWith('.ts') ? [target] : []
  const out: string[] = []
  for (const entry of readdirSync(target)) {
    out.push(...collectFiles(path.join(target, entry)))
  }
  return out
}

describe('runner core provider neutrality', () => {
  for (const forbidden of FORBIDDEN_IMPORTS) {
    it(`packages/runner/src/** must not statically import from "${forbidden}"`, () => {
      const offenders: string[] = []
      const escaped = forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const staticRe = new RegExp(`(?:from\\s+|require\\(\\s*)['"]${escaped}['"]`)
      for (const file of collectFiles(RUNNER_ROOT)) {
        const src = readFileSync(file, 'utf-8')
        if (staticRe.test(src)) offenders.push(path.relative(RUNNER_ROOT, file))
      }
      expect(
        offenders,
        `These files still import "${forbidden}". Route through @coro-ai/plugin-sdk instead.`,
      ).toEqual([])
    })

    it(`dynamic import("${forbidden}") is only allowed from plugins/builtin/index.ts`, () => {
      const offenders: string[] = []
      const escaped = forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const dynamicRe = new RegExp(`import\\(\\s*['"]${escaped}['"]\\s*\\)`)
      for (const file of collectFiles(RUNNER_ROOT)) {
        const rel = path.relative(RUNNER_ROOT, file)
        if (DYNAMIC_IMPORT_ALLOWLIST.has(path.normalize(rel))) continue
        const src = readFileSync(file, 'utf-8')
        if (dynamicRe.test(src)) offenders.push(rel)
      }
      expect(offenders).toEqual([])
    })
  }
})
