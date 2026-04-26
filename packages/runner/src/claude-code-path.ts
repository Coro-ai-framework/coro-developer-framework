import { accessSync, chmodSync, constants, existsSync } from 'fs'
import { createRequire } from 'module'
import path from 'path'
import { Logger } from 'pino'

/**
 * Resolve the path the Claude Agent SDK should spawn (returned via the
 * SDK's `pathToClaudeCodeExecutable` option).
 *
 * The SDK has shipped in two distribution shapes that we both need to handle:
 *
 *   - **Modern (>=0.2.x)** — `@anthropic-ai/claude-agent-sdk` itself ships
 *     only JS modules; the actual `claude` executable lives inside a
 *     platform-specific optional dependency such as
 *     `@anthropic-ai/claude-agent-sdk-darwin-arm64`. npm/pnpm install only
 *     the package matching the host's `os`/`cpu`, and we resolve its
 *     `claude` binary directly.
 *
 *   - **Legacy (<=0.1.x)** — the main package shipped a `cli.js` next to
 *     `sdk.mjs`, and the SDK spawned that file with `node`.
 *
 * Resolution order (first match wins):
 *
 *   1. `CLAUDE_CODE_CLI_PATH` env var (operator override).
 *   2. Modern shape: platform-specific `claude` binary.
 *   3. Legacy shape: `cli.js` next to the SDK main entry.
 *
 * We anchor `require.resolve` at `__filename` so resolution always succeeds
 * from inside the runner package, independent of the user's CWD — pnpm does
 * not hoist the SDK to the workspace root, so anchoring at `process.cwd()`
 * fails with "Cannot find module" when the dashboard is launched from the
 * monorepo root.
 */
export function resolveClaudeCodeCliPath(): string {
  const env = process.env['CLAUDE_CODE_CLI_PATH']
  if (env && existsSync(env)) return path.resolve(env)

  const localRequire = createRequire(__filename)

  // Locate the SDK main entry first; both shapes branch off this anchor.
  let sdkMain: string
  try {
    sdkMain = localRequire.resolve('@anthropic-ai/claude-agent-sdk')
  } catch (err) {
    throw new Error(
      `Could not locate @anthropic-ai/claude-agent-sdk from the runner module. ` +
        `Run \`pnpm install\` or set CLAUDE_CODE_CLI_PATH. Underlying error: ${(err as Error).message}`,
    )
  }

  const platformPackage = nativePlatformPackageName()
  if (platformPackage) {
    try {
      // Anchor at the SDK main: with pnpm the platform package is only
      // hoisted into the SDK's own module graph (as an optionalDependency),
      // not next to the runner's node_modules.
      const sdkRequire = createRequire(sdkMain)
      const platformPkgJson = sdkRequire.resolve(`${platformPackage}/package.json`)
      const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude'
      const binary = path.join(path.dirname(platformPkgJson), binaryName)
      if (existsSync(binary)) return binary
    } catch {
      // Optional package missing for this platform — fall through to legacy.
    }
  }

  const legacy = path.join(path.dirname(sdkMain), 'cli.js')
  if (existsSync(legacy)) return legacy

  const tried = [platformPackage ?? '<no platform package matched>', legacy]
  throw new Error(
    `Could not locate the Claude Agent SDK executable. Tried: ${tried.join(
      ', ',
    )}. Run \`pnpm install\` or set CLAUDE_CODE_CLI_PATH to a working binary.`,
  )
}

function nativePlatformPackageName(): string | null {
  const platform = process.platform
  const arch = process.arch
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') return null
  if (arch !== 'x64' && arch !== 'arm64') return null
  // Note: on linux/musl the SDK ships a separate `-musl` package. npm's
  // optionalDependencies installer normally picks the right one based on
  // the host libc, so we don't try to detect it here. If a musl host ends
  // up with the glibc binary by mistake, the operator can point
  // CLAUDE_CODE_CLI_PATH at the correct install.
  return `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`
}

/**
 * Make sure the resolved Claude executable is runnable.
 *
 * - The modern native `claude` binary is normally already 755, but pnpm's
 *   content-addressable store has been observed to flatten permissions in
 *   edge cases.
 * - The legacy `cli.js` was published 644 by npm, so it always needed a
 *   chmod fix.
 *
 * Either way, this is a defensive `chmod +x` with a clear log message.
 */
export function ensureClaudeCodeCliExecutable(executablePath: string, logger: Logger): void {
  if (!existsSync(executablePath)) {
    logger.warn(
      { executablePath },
      'Claude Agent SDK executable missing — reinstall @anthropic-ai/claude-agent-sdk or set CLAUDE_CODE_CLI_PATH',
    )
    return
  }
  try {
    accessSync(executablePath, constants.X_OK)
  } catch {
    try {
      chmodSync(executablePath, 0o755)
      logger.info({ executablePath }, 'Made Claude Agent SDK executable runnable (chmod +x)')
    } catch (err) {
      logger.warn(
        { executablePath, err },
        `Could not chmod Claude Agent SDK executable — run: chmod +x ${executablePath}`,
      )
    }
  }
}
