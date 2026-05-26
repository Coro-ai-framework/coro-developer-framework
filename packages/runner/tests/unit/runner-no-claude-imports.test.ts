/**
 * Lint test — keeps the runner core provider-neutral.
 *
 * After Phase E of the "Anthropic-as-plugin" work, no source under
 * `packages/runner/src/**` may carry a top-level `import` from
 * `@anthropic-ai/claude-agent-sdk` or `@coro-ai/llm-anthropic`. The
 * Anthropic plugin ships in-box but is loaded through the built-in
 * plugin registry via `await import('@coro-ai/llm-anthropic')`, which
 * deliberately evades this regex — the runner core stays a pure
 * shell that talks to executors only through `@coro-ai/plugin-sdk`.
 *
 * This guards against future regressions where someone reaches for
 * `Query` / `SDKUserMessage` / `PushableInput` instead of the neutral
 * `ExecutorSessionController` / `DeveloperInputChannel` /
 * `ConversationMessage` types from `@coro-ai/plugin-sdk`.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const FORBIDDEN_IMPORTS = [
  '@anthropic-ai/claude-agent-sdk',
  '@coro-ai/llm-anthropic',
] as const

const RUNNER_ROOT = path.resolve(__dirname, '../../src')
const TARGETS = [RUNNER_ROOT]

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
      for (const target of TARGETS) {
        for (const file of collectFiles(target)) {
          const src = readFileSync(file, 'utf-8')
          // Match `from '<forbidden>'` or `from "<forbidden>"` in either
          // an `import` or a `require()` statement. Dynamic imports
          // (`await import('<forbidden>')`) are intentionally allowed
          // — they're how the built-in plugin registry loads the
          // shipped Anthropic plugin without coupling the core to it.
          const re = new RegExp(
            `(?:from\\s+|require\\(\\s*)['"]${forbidden.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}['"]`,
          )
          if (re.test(src)) offenders.push(path.relative(RUNNER_ROOT, file))
        }
      }
      expect(
        offenders,
        `These files still import "${forbidden}". Route through @coro-ai/plugin-sdk instead, or use a dynamic \`await import(...)\` if you genuinely need the plugin module.`,
      ).toEqual([])
    })
  }
})
