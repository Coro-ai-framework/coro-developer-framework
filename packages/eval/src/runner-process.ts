import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { sleep, tailLines } from './util'

/**
 * Start and stop a Coro runner as a child process.
 *
 * The harness drives Coro the way a person does: `coro start` from the built
 * CLI, then HTTP. It never imports the runner.
 */

export function runnerEntry(coroPath: string): string {
  return path.join(coroPath, 'packages', 'runner', 'dist', 'cli', 'index.js')
}

// ── Ports ────────────────────────────────────────────────────────────────────

const reservedPorts = new Set<number>()

/** Ask the OS for a free port. Remembered so two attempts never get the same one. */
export async function reservePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        server.close(() => {
          if (address && typeof address === 'object') resolve(address.port)
          else reject(new Error('could not read the reserved port'))
        })
      })
    })
    if (!reservedPorts.has(port)) {
      reservedPorts.add(port)
      return port
    }
  }
  throw new Error('could not reserve a free port')
}

// ── Process handles ──────────────────────────────────────────────────────────

export interface RunnerHandle {
  readonly baseUrl: string
  readonly port: number
  readonly pid: number
  hasExited(): boolean
  /** `exit code 1` / `signal SIGKILL`, once the process has exited. */
  exitDescription(): string | undefined
  /** SIGTERM the process group, then SIGKILL after `graceMs`. Safe to call twice. */
  stop(graceMs?: number): Promise<void>
}

const active = new Set<RunnerHandle>()

export async function stopAllRunners(): Promise<void> {
  await Promise.all([...active].map(handle => handle.stop(3_000)))
}

/** Last-resort cleanup for `process.on('exit')`: no awaiting allowed there. */
export function killAllRunnersSync(): void {
  for (const handle of active) {
    try {
      process.kill(-handle.pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

export interface StartRunnerOptions {
  coroPath: string
  configPath: string
  /** Becomes the runner's working directory, so it never reads a `.env` from the Coro checkout. */
  cwd: string
  env: NodeJS.ProcessEnv
  /** Runner stdout and stderr are appended here. */
  logPath: string
  startupTimeoutMs?: number
}

/** A grace-period timer that does not keep the harness alive once the race is won. */
function unrefSleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms).unref()
  })
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    // the group is already gone
  }
}

export async function startRunner(options: StartRunnerOptions): Promise<RunnerHandle> {
  const entry = runnerEntry(options.coroPath)
  if (!fs.existsSync(entry)) {
    throw new Error(
      `Coro is not built: ${entry} does not exist. Run \`pnpm build\` in ${options.coroPath} first; the harness does not build it.`,
    )
  }

  const port = await reservePort()
  const logFd = fs.openSync(options.logPath, 'a')
  const child = spawn(
    process.execPath,
    [entry, 'start', '--config', options.configPath, '-p', String(port), '--no-open'],
    // Its own process group, so stopping it also stops the agent subprocesses it spawned.
    { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', logFd, logFd] },
  )
  fs.closeSync(logFd)

  const pid = child.pid
  if (!pid) throw new Error(`could not spawn ${process.execPath} ${entry}`)

  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
  const exited = new Promise<void>(resolve => {
    child.once('exit', (code, signal) => {
      exit = { code, signal }
      resolve()
    })
    child.once('error', () => {
      exit = exit ?? { code: null, signal: null }
      resolve()
    })
  })

  const handle: RunnerHandle = {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    pid,
    hasExited: () => exit !== undefined,
    exitDescription: () =>
      exit ? (exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code ?? 'unknown'}`) : undefined,
    async stop(graceMs = 10_000) {
      if (exit === undefined) {
        signalGroup(pid, 'SIGTERM')
        await Promise.race([exited, unrefSleep(graceMs)])
        if (exit === undefined) {
          signalGroup(pid, 'SIGKILL')
          await Promise.race([exited, unrefSleep(5_000)])
        }
      }
      // The runner may be gone while an agent subprocess it started is not.
      signalGroup(pid, 'SIGKILL')
      active.delete(handle)
      reservedPorts.delete(port)
    },
  }
  active.add(handle)

  try {
    await waitForHealth(handle, options.logPath, options.startupTimeoutMs ?? 90_000)
  } catch (error) {
    await handle.stop(2_000)
    throw error
  }
  return handle
}

async function waitForHealth(handle: RunnerHandle, logPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const logTail = (): string => {
    try {
      return tailLines(fs.readFileSync(logPath, 'utf-8'), 25)
    } catch {
      return '(no runner log)'
    }
  }
  while (Date.now() < deadline) {
    if (handle.hasExited()) {
      throw new Error(`Runner exited during startup (${handle.exitDescription()}). Last log lines:\n${logTail()}`)
    }
    try {
      const response = await fetch(`${handle.baseUrl}/health`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch {
      // not listening yet
    }
    await sleep(300)
  }
  throw new Error(`Runner did not become healthy within ${Math.round(timeoutMs / 1000)}s. Last log lines:\n${logTail()}`)
}
