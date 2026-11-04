import { spawn } from 'child_process'
import type { ContractChecker } from './policy'

export interface CheckerResult {
  glob: string
  command: string
  ok: boolean
  skipped?: string
  output: string
}

/**
 * User- or tenant-configured contract checkers. They compare spec files in
 * the base and head worktrees. A missing binary is skipped, never invented.
 * Pull-request code is not executed.
 */
export async function runContractCheckers(
  checkers: ContractChecker[],
  baseDir: string,
  headDir: string,
  timeoutMs = 30_000,
): Promise<CheckerResult[]> {
  const results: CheckerResult[] = []
  for (const checker of checkers) {
    const command = checker.command
      .replaceAll('{base}', baseDir)
      .replaceAll('{head}', headDir)
    const bin = command.split(/\s+/)[0] ?? ''
    results.push(await runOne(checker, bin, command, timeoutMs))
  }
  return results
}

function runOne(checker: ContractChecker, bin: string, command: string, timeoutMs: number): Promise<CheckerResult> {
  return new Promise(resolve => {
    const child = spawn('sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    child.on('error', err => {
      clearTimeout(timer)
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
      resolve({
        glob: checker.glob,
        command: checker.command,
        ok: false,
        skipped: missing ? `binary not found: ${bin}` : err.message,
        output: '',
      })
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 127) {
        resolve({ glob: checker.glob, command: checker.command, ok: false, skipped: `binary not found: ${bin}`, output: output.slice(0, 4000) })
        return
      }
      resolve({ glob: checker.glob, command: checker.command, ok: code === 0, output: output.slice(0, 4000) })
    })
  })
}
