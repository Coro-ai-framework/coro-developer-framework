import { spawn, type ChildProcessByStdio } from 'node:child_process'
import path from 'node:path'
import type { Readable } from 'node:stream'

import {
  buildDesktopRunnerLaunchSpec,
  chooseDesktopRunnerPort,
  DESKTOP_RUNNER_PACKAGED_STARTUP_TIMEOUT_MS,
  DESKTOP_RUNNER_STARTUP_TIMEOUT_MS,
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
  /** Packaged app installs use a longer health-poll budget for cold boot. */
  packaged?: boolean
  onUnexpectedExit?: (message: string) => void
}

const SHUTDOWN_TIMEOUT_MS = 5_000
const HEALTH_POLL_INTERVAL_MS = 200
const MAX_LOG_LINES = 80
const MAX_STDERR_LINES = 40

type RunnerChildProcess = ChildProcessByStdio<null, Readable, Readable>

export class RunnerSidecar {
  private readonly resourcesRoot: string
  private readonly configPath?: string
  private readonly startupTimeoutMs: number
  private readonly onUnexpectedExit?: (message: string) => void

  private child: RunnerChildProcess | null = null
  private startup: SidecarStartResult | null = null
  private stopping = false
  private readonly recentLogs: string[] = []
  private readonly recentStderrLines: string[] = []

  constructor(options: RunnerSidecarOptions) {
    this.resourcesRoot = options.resourcesRoot
    this.configPath = options.configPath
    this.startupTimeoutMs = options.packaged
      ? DESKTOP_RUNNER_PACKAGED_STARTUP_TIMEOUT_MS
      : DESKTOP_RUNNER_STARTUP_TIMEOUT_MS
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

    const child = spawn(process.execPath, launchSpec.commandArgs, {
      cwd: layout.runnerDir,
      env: {
        ...launchSpec.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    this.attachLogStream(child, 'stdout')
    this.attachLogStream(child, 'stderr')
    this.attachUnexpectedExitHandler(child)

    await waitForRunnerReady(launchSpec.urls.health, child, this.startupTimeoutMs)

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

  /** Recent runner stderr lines for startup failure dialogs. */
  recentStderr(): readonly string[] {
    return this.recentStderrLines
  }

  formatStartupError(message: string): string {
    const parts = [message]
    const remediation = buildStartupRemediation(message, this.recentStderrLines.join('\n'))
    if (remediation) {
      parts.push('', remediation)
    }

    const stderr = this.recentStderrLines.join('\n').trim()
    if (stderr) {
      parts.push('', 'Runner stderr:', stderr)
    }

    return parts.join('\n')
  }

  private attachLogStream(child: RunnerChildProcess, source: 'stdout' | 'stderr'): void {
    const stream = source === 'stdout' ? child.stdout : child.stderr
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      const text = String(chunk)
      for (const rawLine of text.split('\n')) {
        const line = rawLine.trim()
        if (!line) continue
        this.pushLog(`[runner:${source}] ${line}`, source)
        console.log(`[runner:${source}] ${line}`)
      }
    })
  }

  private attachUnexpectedExitHandler(child: RunnerChildProcess): void {
    child.once('exit', (code, signal) => {
      if (this.stopping) return

      const reason = this.formatStartupError([
        'The Coro runner sidecar exited unexpectedly.',
        `exitCode=${code ?? 'null'}`,
        `signal=${signal ?? 'null'}`,
        this.recentLogs.length > 0 ? `recentLogs=\n${this.recentLogs.join('\n')}` : 'recentLogs=<none>',
      ].join(' '))

      this.child = null
      this.startup = null
      this.onUnexpectedExit?.(reason)
    })
  }

  private pushLog(line: string, source: 'stdout' | 'stderr'): void {
    this.recentLogs.push(line)
    if (this.recentLogs.length > MAX_LOG_LINES) {
      this.recentLogs.splice(0, this.recentLogs.length - MAX_LOG_LINES)
    }

    if (source === 'stderr') {
      this.recentStderrLines.push(line)
      if (this.recentStderrLines.length > MAX_STDERR_LINES) {
        this.recentStderrLines.splice(0, this.recentStderrLines.length - MAX_STDERR_LINES)
      }
    }
  }
}

async function waitForRunnerReady(
  url: string,
  child: RunnerChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

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

  throw new Error(`Runner sidecar did not report healthy within ${timeoutMs}ms (${url})`)
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

function buildStartupRemediation(message: string, stderr: string): string | null {
  const combined = `${message}\n${stderr}`.toLowerCase()

  if (combined.includes('desktop resource layout is incomplete') || combined.includes('missing paths:')) {
    const missingMatch = /missing paths?: ([^\n]+)/i.exec(`${message}\n${stderr}`)
    const missingDetail = missingMatch?.[1]?.trim()
    return [
      'What to try:',
      missingDetail ? `- Missing file(s): ${missingDetail}` : '- Bundled runner resources are incomplete.',
      '- Quit Coro and reinstall from the latest release.',
      '- If the problem persists, delete the app and install again (do not copy partial folders).',
    ].join('\n')
  }

  if (
    combined.includes('could not locate the claude agent sdk') ||
    combined.includes('claude-agent-sdk') ||
    combined.includes('claude_code_cli_path')
  ) {
    return [
      'What to try:',
      '- Reinstall Coro from the latest signed release.',
      process.platform === 'win32'
        ? '- If Windows Defender quarantined claude.exe, add an exclusion for your Coro install folder (typically %LOCALAPPDATA%\\Programs\\Coro\\) or restore the file from quarantine.'
        : '- If macOS blocked the Claude binary, allow it in System Settings → Privacy & Security.',
      '- Advanced: set environment variable CLAUDE_CODE_CLI_PATH to a working claude binary before launching Coro.',
    ].join('\n')
  }

  if (combined.includes('did not report healthy')) {
    return [
      'What to try:',
      '- Wait a moment and relaunch — first boot can take up to a minute.',
      '- Check that no other app is blocking port 3000 on 127.0.0.1.',
      '- Reinstall if the runner never becomes healthy.',
    ].join('\n')
  }

  if (combined.includes('eacces') || combined.includes('eperm') || combined.includes('operation not permitted')) {
    return [
      'What to try:',
      '- Your security software may be blocking Coro from starting a helper process.',
      '- Add Coro to your antivirus/Defender allow list and relaunch.',
    ].join('\n')
  }

  return null
}
