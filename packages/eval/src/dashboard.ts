import fs from 'node:fs'
import http, { type Server } from 'node:http'
import path from 'node:path'
import { DASHBOARD_HTML } from './dashboard-page'
import type { Grade } from './grade'
import { summarize } from './report'
import { ResultStore, RESULTS_DIR, type IndexRecord } from './store'
import type { AttemptMeta, Timeline } from './types'

export interface DashboardOptions {
  resultsDir?: string
  host?: string
  port?: number
}

export interface DashboardServer {
  server: Server
  url: string
}

interface RunView {
  info: ReturnType<ResultStore['readRun']>
  summary: ReturnType<typeof summarize>
  attempts: IndexRecord[]
}

function readOptional<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T
  } catch {
    return undefined
  }
}

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}

function sendHtml(response: http.ServerResponse): void {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(DASHBOARD_HTML)
}

function loadRun(store: ResultStore, runId: string): RunView {
  if (!store.listRunIds().includes(runId)) throw new DashboardNotFound(`Run "${runId}" was not found`)
  const attempts = store
    .readRunRecords(runId)
    .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.attempt - b.attempt)
  return {
    info: store.readRun(runId),
    summary: summarize(attempts),
    attempts,
  }
}

class DashboardNotFound extends Error {}

function attemptArtifactsDir(store: ResultStore, runId: string, taskId: string, attempt: number): string {
  const attemptsRoot = path.resolve(store.runDir(runId), 'attempts')
  const candidate = path.resolve(attemptsRoot, `${taskId}-${attempt}`)
  if (!candidate.startsWith(`${attemptsRoot}${path.sep}`) || !fs.existsSync(candidate)) {
    throw new DashboardNotFound(`Attempt ${taskId} #${attempt} has no artifacts`)
  }

  const realRoot = fs.realpathSync(attemptsRoot)
  const realCandidate = fs.realpathSync(candidate)
  if (!realCandidate.startsWith(`${realRoot}${path.sep}`)) {
    throw new DashboardNotFound(`Attempt ${taskId} #${attempt} has invalid artifacts`)
  }
  return realCandidate
}

function artifactPath(dir: string, name: string): string | undefined {
  const candidate = path.join(dir, name)
  if (!fs.existsSync(candidate)) return undefined
  const real = fs.realpathSync(candidate)
  return real.startsWith(`${dir}${path.sep}`) ? real : undefined
}

function attemptView(store: ResultStore, runId: string, taskId: string, attempt: number): unknown {
  const run = loadRun(store, runId)
  const record = run.attempts.find(item => item.taskId === taskId && item.attempt === attempt)
  if (!record) throw new DashboardNotFound(`Attempt ${taskId} #${attempt} was not found`)

  const dir = attemptArtifactsDir(store, runId, record.taskId, record.attempt)
  const meta = artifactPath(dir, 'attempt.json')
  const grade = artifactPath(dir, 'grade.json')
  const timeline = artifactPath(dir, 'timeline.json')
  const diff = artifactPath(dir, 'diff.patch')
  return {
    record,
    meta: meta ? readOptional<AttemptMeta>(meta) : undefined,
    grade: grade ? readOptional<Grade>(grade) : undefined,
    timeline: timeline ? readOptional<Timeline>(timeline) : undefined,
    diff: diff ? fs.readFileSync(diff, 'utf-8') : '',
  }
}

function route(store: ResultStore, request: http.IncomingMessage, response: http.ServerResponse): void {
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed' })
    return
  }

  try {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const parts = url.pathname
      .split('/')
      .filter(Boolean)
      .map(part => decodeURIComponent(part))

    if (url.pathname === '/' || url.pathname === '/index.html') {
      sendHtml(response)
      return
    }

    if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'runs') {
      const recordsByRun = new Map<string, IndexRecord[]>()
      for (const record of store.readIndex()) {
        const records = recordsByRun.get(record.runId) ?? []
        records.push(record)
        recordsByRun.set(record.runId, records)
      }
      const runs = store
        .listRunIds()
        .reverse()
        .flatMap(runId => {
          try {
            const info = store.readRun(runId)
            const summary = summarize(recordsByRun.get(runId) ?? [])
            return [
              {
                runId: info.runId,
                label: info.label,
                startedAt: info.startedAt,
                finishedAt: info.finishedAt,
                scenarioHash: info.scenarioHash,
                lane: info.scenario.lane,
                overall: summary.overall,
              },
            ]
          } catch {
            // A half-written run should not hide every healthy run in the list.
            return []
          }
        })
      sendJson(response, 200, runs)
      return
    }

    if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'runs') {
      sendJson(response, 200, loadRun(store, parts[2]!))
      return
    }

    if (
      parts.length === 6 &&
      parts[0] === 'api' &&
      parts[1] === 'runs' &&
      parts[3] === 'attempts'
    ) {
      const attempt = Number(parts[5])
      if (!Number.isInteger(attempt) || attempt < 1) throw new DashboardNotFound('Attempt was not found')
      sendJson(response, 200, attemptView(store, parts[2]!, parts[4]!, attempt))
      return
    }

    throw new DashboardNotFound('Page not found')
  } catch (error) {
    if (error instanceof DashboardNotFound || error instanceof URIError) {
      sendJson(response, 404, { error: error.message })
      return
    }
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

/** Start the read-only local results dashboard. Passing port 0 chooses a free port, which is useful in tests. */
export async function startDashboard(options: DashboardOptions = {}): Promise<DashboardServer> {
  const store = new ResultStore(path.resolve(options.resultsDir ?? RESULTS_DIR))
  const host = options.host ?? '127.0.0.1'
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('The eval dashboard is read-only but unauthenticated, so --host must be a loopback address')
  }
  const port = options.port ?? 4310
  const server = http.createServer((request, response) => route(store, request, response))

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Dashboard did not bind to a TCP port')
  }
  const urlHost = host.includes(':') ? `[${host}]` : host
  return { server, url: `http://${urlHost}:${address.port}` }
}

/** Keep a CLI dashboard command alive until it is interrupted. */
export async function serveDashboard(options: DashboardOptions = {}): Promise<void> {
  const { server, url } = await startDashboard(options)
  console.log(`Eval dashboard: ${url}`)
  console.log(`Results: ${path.resolve(options.resultsDir ?? RESULTS_DIR)}`)

  await new Promise<void>(resolve => {
    const stop = (): void => {
      server.close(() => resolve())
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    server.once('close', () => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      resolve()
    })
  })
}
