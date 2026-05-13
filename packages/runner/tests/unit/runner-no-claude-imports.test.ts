/**
 * Lint test — keeps the runner core provider-neutral.
 *
 * After Phase A of the "Anthropic-as-plugin" work, no source under
 * `packages/runner/src/jobs/**`, `packages/runner/src/mcp-server.ts`,
 * or `packages/runner/src/mcp-handlers.ts` may import from
 * `@anthropic-ai/claude-agent-sdk` or `@coro/llm-anthropic`. All
 * Anthropic specifics live in the plugin (`packages/llm-anthropic`),
 * and the MCP framework primitives (`tool`, `createSdkMcpServer`)
 * are re-exported through `@coro/plugin-sdk`.
 *
 * This guards against future regressions where someone reaches for
 * `Query` / `SDKUserMessage` / `PushableInput` instead of the neutral
 * `ExecutorSessionController` / `DeveloperInputChannel` /
 * `ConversationMessage` types from `@coro/plugin-sdk`.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const FORBIDDEN_IMPORTS = [
  '@anthropic-ai/claude-agent-sdk',
  '@coro/llm-anthropic',
] as const

const RUNNER_ROOT = path.resolve(__dirname, '../../src')
const TARGETS = [
  path.join(RUNNER_ROOT, 'jobs'),
  path.join(RUNNER_ROOT, 'mcp-server.ts'),
  path.join(RUNNER_ROOT, 'mcp-handlers.ts'),
]

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
    it(`packages/runner/src/{jobs,mcp-*.ts} must not import from "${forbidden}"`, () => {
      const offenders: string[] = []
      for (const target of TARGETS) {
        for (const file of collectFiles(target)) {
          const src = readFileSync(file, 'utf-8')
          // Match `from '<forbidden>'` or `from "<forbidden>"` in either
          // an `import` or a `require()` statement.
          const re = new RegExp(
            `(?:from\\s+|require\\(\\s*)['"]${forbidden.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}['"]`,
          )
          if (re.test(src)) offenders.push(path.relative(RUNNER_ROOT, file))
        }
      }
      expect(
        offenders,
        `These files still import "${forbidden}". Route through @coro/plugin-sdk instead.`,
      ).toEqual([])
    })
  }
})
