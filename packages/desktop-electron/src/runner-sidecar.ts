import { spawn, type ChildProcessByStdio } from 'node:child_process'
import path from 'node:path'
import type { Readable } from 'node:stream'

import {
  buildDesktopRunnerLaunchSpec,
  chooseDesktopRunnerPort,
  resolveDesktopResourceLayout,
  validateDesktopResourceLayout,
  type DesktopPortSelection,
  type DesktopResourceLayout,
  type DesktopRunnerLaunchSpec,
} from '../../runner/src/desktop'

export interface SidecarStartResult {
  layout: DesktopResourceLayout
  portSelection: DesktopPortSelection
  launchSpec: DesktopRunnerLaunchSpec
}

export interface RunnerSidecarOptions {
  resourcesRoot: string
  configPath?: string
  onUnexpectedExit?: (message: string) => void
}

const STARTUP_TIMEOUT_MS = 15_000
const SHUTDOWN_TIMEOUT_MS = 5_000
const HEALTH_POLL_INTERVAL_MS = 200
const MAX_LOG_LINES = 80

type RunnerChildProcess = ChildProcessByStdio<null, Readable, Readable>

export class RunnerSidecar {
  private readonly resourcesRoot: string
  private readonly configPath?: string
  private readonly onUnexpectedExit?: (message: string) => void

  private child: RunnerChildProcess | null = null
  private startup: SidecarStartResult | null = null
  private stopping = false
  private readonly recentLogs: string[] = []

  constructor(options: RunnerSidecarOptions) {
    this.resourcesRoot = options.resourcesRoot
    this.configPath = options.configPath
    this.onUnexpectedExit = options.onUnexpectedExit
  }

  async start(): Promise<SidecarStartResult> {
    if (this.startup) return this.startup
    if (this.child) throw new Error('Runner sidecar is already starting')

    const layout = resolveDesktopResourceLayout(this.resourcesRoot)
    validateDesktopResourceLayout(layout)

    const portSelection = await chooseDesktopRunnerPort()
    const launchSpec = buildDesktopRunnerLaunchSpec({
      port: portSelection.port,
      dashboardDist: layout.dashboardDistDir,
      configPath: this.configPath,
      env: process.env,
    })

    const child = spawn(layout.nodeExecutable, launchSpec.commandArgs, {
      cwd: layout.runnerDir,
      env: launchSpec.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    this.attachLogStream(child, 'stdout')
    this.attachLogStream(child, 'stderr')
    this.attachUnexpectedExitHandler(child)

    await waitForRunnerReady(launchSpec.urls.health, child)

    this.startup = { layout, portSelection, launchSpec }
    return this.startup
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) return

    this.stopping = true
    try {
      child.kill('SIGTERM')
    } catch {
      // ignore: the child may already be gone
    }

    const exited = await waitForChildExit(child, SHUTDOWN_TIMEOUT_MS)
    if (!exited) {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore: the child may already be gone
      }
      await waitForChildExit(child, SHUTDOWN_TIMEOUT_MS)
    }

    this.child = null
    this.startup = null
    this.stopping = false
  }

  dashboardUrl(): string | null {
    return this.startup?.launchSpec.urls.dashboard ?? null
  }

  dashboardOrigin(): string | null {
    return this.startup?.launchSpec.urls.origin ?? null
  }

  private attachLogStream(child: RunnerChildProcess, source: 'stdout' | 'stderr'): void {
    const stream = source === 'stdout' ? child.stdout : child.stderr
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      const text = String(chunk)
      for (const rawLine of text.split('\n')) {
        const line = rawLine.trim()
        if (!line) continue
        this.pushLog(`[runner:${source}] ${line}`)
        console.log(`[runner:${source}] ${line}`)
      }
    })
  }

  private attachUnexpectedExitHandler(child: RunnerChildProcess): void {
    child.once('exit', (code, signal) => {
      if (this.stopping) return

      const reason = [
        'The Coro runner sidecar exited unexpectedly.',
        `exitCode=${code ?? 'null'}`,
        `signal=${signal ?? 'null'}`,
        this.recentLogs.length > 0 ? `recentLogs=\n${this.recentLogs.join('\n')}` : 'recentLogs=<none>',
      ].join(' ')

      this.child = null
      this.startup = null
      this.onUnexpectedExit?.(reason)
    })
  }

  private pushLog(line: string): void {
    this.recentLogs.push(line)
    if (this.recentLogs.length > MAX_LOG_LINES) {
      this.recentLogs.splice(0, this.recentLogs.length - MAX_LOG_LINES)
    }
  }
}

async function waitForRunnerReady(url: string, child: RunnerChildProcess): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Runner sidecar exited before becoming ready (exitCode=${child.exitCode})`)
    }

    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // runner is not ready yet
    }

    await delay(HEALTH_POLL_INTERVAL_MS)
  }

  throw new Error(`Runner sidecar did not report healthy within ${STARTUP_TIMEOUT_MS}ms (${url})`)
}

async function waitForChildExit(
  child: RunnerChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) return true

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup()
      resolve(false)
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timeout)
      child.removeListener('exit', onExit)
    }

    const onExit = () => {
      cleanup()
      resolve(true)
    }

    child.once('exit', onExit)
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function resolveLocalResourcesRoot(currentDir: string): string {
  return path.join(currentDir, 'resources')
}