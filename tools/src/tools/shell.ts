import { exec } from 'child_process'
import path from 'path'
import { JobType } from '../jobs/types'
import { ToolContext } from './types'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 256 * 1024 // 256KB — keep Claude context reasonable

/**
 * Execute a shell command in a sandboxed working directory.
 *
 * Security model:
 *   - Commands always run with `cwd` set to the working directory (or a subdirectory of it).
 *     Agents cannot set cwd to an arbitrary path outside the sandbox.
 *   - SelfUpdate jobs may also run commands in the a5-ai directory.
 *   - Credentials are injected as environment variables by the Agent Host — they are never
 *     logged or returned in tool output.
 *   - The command runs with a timeout (default 2 minutes) to prevent runaway processes.
 *   - Output is truncated if it exceeds 256KB to avoid flooding Claude's context window.
 */
export async function shellExec(
  input: {
    command: string
    workingDir?: string
    timeoutMs?: number
    env?: Record<string, string>
  },
  ctx: ToolContext,
): Promise<unknown> {
  const allowedRoots = [ctx.settings.paths.workingDir]
  if (ctx.job.type === JobType.SelfUpdate) {
    allowedRoots.push(ctx.settings.paths.a5aiDir)
  }

  // Resolve cwd: default to workingDir, allow subdirectories
  let cwd = ctx.settings.paths.workingDir
  if (input.workingDir) {
    cwd = path.isAbsolute(input.workingDir)
      ? input.workingDir
      : path.resolve(ctx.settings.paths.workingDir, input.workingDir)
  }

  const withinAllowed = allowedRoots.some(r => cwd === r || cwd.startsWith(r + path.sep))
  if (!withinAllowed) {
    throw new Error(
      `workingDir "${cwd}" is outside allowed directories.\nAllowed: ${allowedRoots.join(', ')}`,
    )
  }

  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Build env: inherit process env, add credentials, merge caller overrides
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    GIT_TERMINAL_PROMPT: '0',
    ...input.env,
  }

  return new Promise((resolve, reject) => {
    const child = exec(input.command, {
      cwd,
      timeout,
      maxBuffer: MAX_OUTPUT_BYTES * 2,
      env,
      shell: '/bin/bash',
    }, (error, stdout, stderr) => {
      const exitCode = error ? (error as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0

      const result = {
        exitCode,
        stdout: truncate(stdout, MAX_OUTPUT_BYTES),
        stderr: truncate(stderr, MAX_OUTPUT_BYTES),
      }

      if (error && !stdout && !stderr) {
        reject(new Error(`Command failed (exit ${exitCode}): ${error.message}`))
      } else {
        // Return output even on non-zero exit — the agent needs to see build errors, test failures, etc.
        resolve(result)
      }
    })

    child.on('error', reject)
  })
}

function truncate(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str) <= maxBytes) return str
  const truncated = Buffer.from(str).subarray(0, maxBytes).toString('utf-8')
  return truncated + '\n... (output truncated)'
}
