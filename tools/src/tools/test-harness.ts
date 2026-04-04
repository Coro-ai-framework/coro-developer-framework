import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { ToolContext, ToolResult } from './types'

const execAsync = promisify(exec)

// ── Tools ─────────────────────────────────────────────────────────────────────

/**
 * Build a Go service. Runs `go build ./...` in the given directory.
 * Requires Go to be installed in the container (add to Dockerfile in Phase 10).
 */
export async function runGoBuild(
  input: { repoDir: string },
  _ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await execAsync('go build ./...', {
      cwd: input.repoDir,
      timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return {
      success: true,
      output: { stdout: stdout.trim(), stderr: stderr.trim() },
    }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return {
      success: false,
      error: e.stderr ?? e.message ?? String(err),
    }
  }
}

/**
 * Start a Go service in the background on the given port.
 * The process is tracked by `label` so it can be stopped later with stop_go_service.
 */
export async function startGoService(
  input: {
    label: string
    repoDir: string
    binaryName: string
    port: number
    env?: Record<string, string>
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (ctx.runningServices.has(input.label)) {
    return { success: false, error: `Service "${input.label}" is already running` }
  }

  try {
    const child = spawn(`./${input.binaryName}`, [], {
      cwd: input.repoDir,
      env: { ...process.env, PORT: String(input.port), ...input.env },
      stdio: 'ignore',
      detached: false,
    })

    ctx.runningServices.set(input.label, child)

    child.on('exit', (code) => {
      ctx.runningServices.delete(input.label)
      ctx.logger.debug({ label: input.label, code }, 'Go service exited')
    })

    // Give the process a moment to bind its port before returning
    await sleep(1500)

    return {
      success: true,
      output: { label: input.label, port: input.port, pid: child.pid },
    }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/**
 * Stop a Go service previously started with start_go_service.
 */
export async function stopGoService(
  input: { label: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const child = ctx.runningServices.get(input.label)
  if (!child) {
    return { success: false, error: `No running service with label "${input.label}"` }
  }

  child.kill('SIGTERM')
  ctx.runningServices.delete(input.label)
  return { success: true, output: { stopped: input.label } }
}

/**
 * Send the same HTTP request to both the Go service and the .NET staging URL,
 * then diff the responses. Returns a structured comparison so the agent can
 * identify contract mismatches without guessing.
 */
export async function compareRequest(
  input: {
    goBaseUrl: string
    dotnetBaseUrl: string
    method: string
    path: string
    headers?: Record<string, string>
    body?: string
  },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const { goBaseUrl, dotnetBaseUrl, method, path: reqPath, headers = {}, body } = input

  try {
    const [goRes, dotnetRes] = await Promise.all([
      httpRequest(`${goBaseUrl}${reqPath}`, method, headers, body),
      httpRequest(`${dotnetBaseUrl}${reqPath}`, method, headers, body),
    ])

    const statusMatch = goRes.status === dotnetRes.status
    const bodyMatch = normalise(goRes.body) === normalise(dotnetRes.body)

    return {
      success: true,
      output: {
        match: statusMatch && bodyMatch,
        go: { status: goRes.status, body: goRes.body },
        dotnet: { status: dotnetRes.status, body: dotnetRes.body },
        diff: {
          statusMismatch: !statusMatch
            ? `Go: ${goRes.status}  .NET: ${dotnetRes.status}`
            : null,
          bodyMismatch: !bodyMatch
            ? diffSummary(goRes.body, dotnetRes.body)
            : null,
        },
      },
    }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function httpRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ?? undefined,
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  return { status: res.status, body: text }
}

/** Normalise JSON bodies for comparison: parse → stable stringify. */
function normalise(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body))
  } catch {
    return body.trim()
  }
}

/**
 * Return a short human-readable diff summary.
 * Full diffs are large — give Claude enough to reason about the mismatch
 * without flooding the context window.
 */
function diffSummary(goBody: string, dotnetBody: string): string {
  try {
    const goParsed = JSON.parse(goBody) as Record<string, unknown>
    const dotnetParsed = JSON.parse(dotnetBody) as Record<string, unknown>

    const allKeys = new Set([...Object.keys(goParsed), ...Object.keys(dotnetParsed)])
    const diffs: string[] = []

    for (const key of allKeys) {
      const goVal = JSON.stringify(goParsed[key])
      const dotnetVal = JSON.stringify(dotnetParsed[key])
      if (goVal !== dotnetVal) {
        diffs.push(`  "${key}": Go=${goVal}  .NET=${dotnetVal}`)
      }
    }

    return diffs.length > 0
      ? `Field mismatches:\n${diffs.slice(0, 20).join('\n')}`
      : 'Bodies differ but keys match (possibly whitespace/ordering)'
  } catch {
    return `Non-JSON bodies differ:\n  Go:   ${goBody.slice(0, 200)}\n  .NET: ${dotnetBody.slice(0, 200)}`
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
