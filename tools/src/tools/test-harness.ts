import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { ToolContext } from './types'

const execAsync = promisify(exec)

export async function runGoBuild(
  input: { repoDir: string },
  _ctx: ToolContext,
): Promise<unknown> {
  try {
    const { stdout, stderr } = await execAsync('go build ./...', {
      cwd: input.repoDir,
      timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return { stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string }
    throw new Error(e.stderr ?? e.message ?? String(err))
  }
}

export async function startGoService(
  input: {
    label: string
    repoDir: string
    binaryName: string
    port: number
    env?: Record<string, string>
  },
  ctx: ToolContext,
): Promise<unknown> {
  if (ctx.runningServices.has(input.label)) {
    throw new Error(`Service "${input.label}" is already running`)
  }

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

  await sleep(1500)

  return { label: input.label, port: input.port, pid: child.pid }
}

export async function stopGoService(
  input: { label: string },
  ctx: ToolContext,
): Promise<unknown> {
  const child = ctx.runningServices.get(input.label)
  if (!child) throw new Error(`No running service with label "${input.label}"`)

  child.kill('SIGTERM')
  ctx.runningServices.delete(input.label)
  return { stopped: input.label }
}

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
): Promise<unknown> {
  const { goBaseUrl, dotnetBaseUrl, method, path: reqPath, headers = {}, body } = input

  const [goRes, dotnetRes] = await Promise.all([
    httpRequest(`${goBaseUrl}${reqPath}`, method, headers, body),
    httpRequest(`${dotnetBaseUrl}${reqPath}`, method, headers, body),
  ])

  const statusMatch = goRes.status === dotnetRes.status
  const bodyMatch = normalise(goRes.body) === normalise(dotnetRes.body)

  return {
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

function normalise(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body))
  } catch {
    return body.trim()
  }
}

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
