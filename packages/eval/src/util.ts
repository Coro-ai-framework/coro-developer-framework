import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── Paths ────────────────────────────────────────────────────────────────────

/** Root of `packages/eval`, regardless of the caller's working directory. */
export const PACKAGE_ROOT = path.resolve(__dirname, '..')

export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

/** Resolve `p` against `base` (defaults to the package root), expanding `~`. */
export function resolvePath(p: string, base: string = PACKAGE_ROOT): string {
  return path.resolve(base, expandHome(p))
}

// ── Time ─────────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function nowIso(): string {
  return new Date().toISOString()
}

// ── Numbers ──────────────────────────────────────────────────────────────────

export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

export function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  return sum(values) / values.length
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** Sample standard deviation; undefined below two values. */
export function stdev(values: readonly number[]): number | undefined {
  if (values.length < 2) return undefined
  const avg = sum(values) / values.length
  const variance = sum(values.map(v => (v - avg) ** 2)) / (values.length - 1)
  return Math.sqrt(variance)
}

export function round(value: number, digits = 4): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

// ── Hashing and serialisation ────────────────────────────────────────────────

/** JSON with object keys sorted, so equal values hash equal. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

export function shortHash(value: unknown, length = 8): string {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, length)
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

// ── Process helpers ──────────────────────────────────────────────────────────

const activeShellGroups = new Set<number>()

/** Kill every command `runShell` has started and not seen finish. For `process.on('exit')`. */
export function killAllShellsSync(): void {
  for (const pid of activeShellGroups) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  activeShellGroups.clear()
}

export interface ShellResult {
  command: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  durationMs: number
  /** Combined stdout + stderr, truncated from the front to `maxOutputBytes`. */
  output: string
  /** Bytes produced before truncation. */
  outputBytes: number
}

export interface ShellOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxOutputBytes?: number
}

/**
 * Run a shell command line (`sh -c`) and capture its combined output.
 *
 * Used for the commands a task declares (`npm ci`, `npx vitest run ...`) and
 * never for anything built from model output. The command runs in its own
 * process group so a timeout can take the whole tree down.
 */
export function runShell(command: string, options: ShellOptions): Promise<ShellResult> {
  const maxBytes = options.maxOutputBytes ?? 256 * 1024
  const started = Date.now()
  return new Promise(resolve => {
    const child = spawn('sh', ['-c', command], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Each command is its own process group, so an interrupted harness has to take them down itself.
    if (child.pid) activeShellGroups.add(child.pid)
    const chunks: Buffer[] = []
    let total = 0
    let kept = 0
    let timedOut = false

    const onData = (chunk: Buffer): void => {
      total += chunk.length
      chunks.push(chunk)
      kept += chunk.length
      while (kept > maxBytes * 2 && chunks.length > 1) kept -= chunks.shift()!.length
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
      } catch {
        // already gone
      }
    }

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          killGroup('SIGTERM')
          setTimeout(() => killGroup('SIGKILL'), 5_000).unref()
        }, options.timeoutMs)
      : undefined

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (child.pid) activeShellGroups.delete(child.pid)
      if (timer) clearTimeout(timer)
      const joined = Buffer.concat(chunks)
      const output = joined.length > maxBytes ? joined.subarray(joined.length - maxBytes) : joined
      resolve({
        command,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - started,
        output: output.toString('utf-8'),
        outputBytes: total,
      })
    }

    child.on('error', err => {
      chunks.push(Buffer.from(String(err)))
      finish(null, null)
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}

export interface ProcessResult {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}

export interface ProcessOptions {
  cwd: string
  /** Exactly the environment the child gets; nothing is inherited. */
  env: NodeJS.ProcessEnv
  /** Written to the child's stdin, which is then closed. */
  stdin?: string
  timeoutMs?: number
  maxOutputBytes?: number
}

/**
 * Run an executable directly (no shell, so arguments need no quoting) and
 * capture stdout and stderr separately. Like `runShell`, the child is its own
 * process group, so a timeout or an interrupted harness takes the tree down.
 */
export function runProcess(file: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  const maxBytes = options.maxOutputBytes ?? 4 * 1024 * 1024
  return new Promise(resolve => {
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    if (child.pid) activeShellGroups.add(child.pid)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBytes) stdout += chunk.toString('utf-8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBytes) stderr += chunk.toString('utf-8')
    })

    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
      } catch {
        // already gone
      }
    }
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          killGroup('SIGTERM')
          setTimeout(() => killGroup('SIGKILL'), 5_000).unref()
        }, options.timeoutMs)
      : undefined

    let done = false
    const finish = (exitCode: number | null): void => {
      if (done) return
      done = true
      if (child.pid) activeShellGroups.delete(child.pid)
      if (timer) clearTimeout(timer)
      resolve({ exitCode, timedOut, stdout, stderr })
    }
    child.on('error', err => {
      stderr += String(err)
      finish(null)
    })
    child.on('close', code => finish(code))
    // A child that exits before reading its stdin raises EPIPE; its exit code is what matters.
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.stdin ?? '')
  })
}

/** The first executable called `name` on the environment's PATH, if any. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // not here
    }
  }
  return undefined
}

/** Run `items` through `fn` with at most `limit` in flight; preserves order. */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index] as T, index)
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker())
  await Promise.all(workers)
  return results
}

/** Last `n` lines of `text`, for error messages that quote a log. */
export function tailLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/)
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}
