import { accessSync, chmodSync, constants, existsSync } from 'fs'
import { createRequire } from 'module'
import path from 'path'
import { Logger } from 'pino'

/**
 * Resolve the Claude Code CLI shipped inside `@anthropic-ai/claude-agent-sdk`.
 * The SDK spawns this file; it must be executable (see `ensureClaudeCodeCliExecutable`).
 *
 * Resolution order (first match wins):
 *   1. `CLAUDE_CODE_CLI_PATH` env var (operator override).
 *   2. The caller's `workingDirectory` — preserved for tooling that wants
 *      to pin to a specific install (e.g. tests against a fixture).
 *   3. The runner module itself (`__filename`). This is the path that
 *      always works, because the SDK is a hard dependency of `@coro/runner`
 *      and pnpm guarantees it is reachable from anywhere inside the
 *      runner package — independent of the user's `process.cwd()`.
 *
 * The third fallback is what makes `coro start` work when launched from
 * the workspace root: pnpm doesn't hoist the SDK to the root `node_modules`,
 * so anchoring resolution at the user's CWD fails with "Cannot find module".
 */
export function resolveClaudeCodeCliPath(workingDirectory?: string): string {
  const env = process.env['CLAUDE_CODE_CLI_PATH']
  if (env && existsSync(env)) return path.resolve(env)

  const candidates: string[] = []
  if (workingDirectory) candidates.push(path.join(workingDirectory, 'package.json'))
  // `__filename` is the compiled .js inside packages/runner/dist/ — the SDK
  // is always reachable from there via the runner's own node_modules.
  candidates.push(__filename)

  let lastError: unknown
  for (const anchor of candidates) {
    try {
      const require = createRequire(anchor)
      const sdkMain: string = require.resolve('@anthropic-ai/claude-agent-sdk')
      return path.join(path.dirname(sdkMain), 'cli.js')
    } catch (err) {
      lastError = err
    }
  }

  throw new Error(
    `Could not resolve @anthropic-ai/claude-agent-sdk from any of: ${candidates.join(', ')}. ` +
      `Run \`pnpm install\` (or set CLAUDE_CODE_CLI_PATH). Underlying error: ${(lastError as Error)?.message}`,
  )
}

/**
 * npm installs `cli.js` as non-executable (644). The Agent SDK checks `access(X_OK)`
 * and throws if the file cannot be executed. Fix by chmod +x when needed.
 */
export function ensureClaudeCodeCliExecutable(cliPath: string, logger: Logger): void {
  if (!existsSync(cliPath)) {
    logger.warn(
      { cliPath },
      'Claude Code cli.js missing — reinstall @anthropic-ai/claude-agent-sdk or set CLAUDE_CODE_CLI_PATH',
    )
    return
  }
  try {
    accessSync(cliPath, constants.X_OK)
  } catch {
    try {
      chmodSync(cliPath, 0o755)
      logger.info({ cliPath }, 'Made bundled Claude Code cli.js executable (was 644 from npm)')
    } catch (err) {
      logger.warn(
        { cliPath, err },
        'Could not chmod Claude Code cli.js; run: chmod +x node_modules/@anthropic-ai/claude-agent-sdk/cli.js',
      )
    }
  }
}
