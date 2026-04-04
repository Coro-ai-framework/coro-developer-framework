import { accessSync, chmodSync, constants, existsSync } from 'fs'
import { createRequire } from 'module'
import path from 'path'
import { Logger } from 'pino'

/**
 * Resolve the Claude Code CLI shipped inside `@anthropic-ai/claude-agent-sdk`.
 * The SDK spawns this file; it must be executable (see `ensureClaudeCodeCliExecutable`).
 */
export function resolveClaudeCodeCliPath(workingDirectory: string): string {
  const env = process.env['CLAUDE_CODE_CLI_PATH']
  if (env && existsSync(env)) return path.resolve(env)

  const require = createRequire(path.join(workingDirectory, 'package.json'))
  const sdkMain: string = require.resolve('@anthropic-ai/claude-agent-sdk')
  return path.join(path.dirname(sdkMain), 'cli.js')
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
