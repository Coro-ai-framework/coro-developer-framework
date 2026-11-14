import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runAttempt } from './attempt'
import { describeCheckout } from './git'
import { selectJudgeBackend, type CompleteFn } from './grade/judge'
import { gradeAttempt, type Grade } from './grade'
import { computeMetrics, type Metrics } from './metrics'
import { summarize, type RunSummary } from './report'
import { runnerEntry } from './runner-process'
import { cachePaths, isolatedEnv, resolveCredentials, type Credentials } from './sandbox'
import { resolveCoroPath, scenarioHash, type Scenario } from './scenario'
import { ResultStore, type IndexRecord, type RunInfo } from './store'
import type { Task } from './tasks'
import type { AttemptMeta } from './types'
import { mapPool, nowIso, PACKAGE_ROOT, runShell } from './util'

/**
 * Runs a scenario over a set of tasks and records every attempt.
 *
 * Attempts are independent (own HOME, own runner process, own port), so they
 * run `parallel` at a time. Each is graded and appended to `index.jsonl` the
 * moment it finishes, so an interrupted run keeps what it completed.
 */

export interface RunOptions {
  scenario: Scenario
  scenarioFile?: string
  /** The `--set` expressions and flags as typed, kept in `run.json`. */
  overrides?: string[]
  label: string
  tasks: Task[]
  store: ResultStore
  /** Parent of the per-attempt scratch directories. Defaults to a directory under the OS temp dir. */
  workRoot?: string
  /** Shared package-manager caches. Defaults to `packages/eval/.cache`. */
  cacheDir?: string
  /** Keep the scratch directories (home, sandbox, graded checkout) after grading. */
  keepWork?: boolean
  env?: NodeJS.ProcessEnv
  /** Overrides, for tests: skip credential discovery and the real judge. */
  credentials?: Credentials
  judgeComplete?: CompleteFn | null
  needsHumanGraceMs?: number
  /** Stops starting new attempts when aborted; running ones are stopped by the caller. */
  signal?: AbortSignal
  /** Called once the run id is known, with the scratch directory it will use. */
  onStart?: (started: { runId: string; workRoot: string }) => void
  log?: (message: string) => void
}

export interface RunResult {
  runId: string
  info: RunInfo
  records: IndexRecord[]
  summary: RunSummary
}

/** The OS temp dir, not the repository: see `sandbox.ts` for why the agent's working directory must not sit inside it. */
export function defaultWorkRoot(): string {
  return path.join(fs.realpathSync(os.tmpdir()), 'coro-eval')
}

export function defaultCacheDir(): string {
  return path.join(PACKAGE_ROOT, '.cache')
}

// ── Before spending anything ─────────────────────────────────────────────────

export interface Problem {
  message: string
}

/** Everything that can be checked without a model call, so a run fails in a second instead of an hour. */
export async function preflight(scenario: Scenario, tasks: readonly Task[]): Promise<Problem[]> {
  const problems: Problem[] = []
  const coroPath = resolveCoroPath(scenario)
  if (!fs.existsSync(runnerEntry(coroPath))) {
    problems.push({
      message:
        `Coro is not built at ${coroPath}: missing ${path.relative(coroPath, runnerEntry(coroPath))}. ` +
        `Run \`pnpm build\` in that checkout first.`,
    })
  }
  if (scenario.tenantOverlayDir && !fs.existsSync(scenario.tenantOverlayDir)) {
    problems.push({ message: `tenantOverlayDir does not exist: ${scenario.tenantOverlayDir}` })
  }
  const needed = new Set<string>(['git', 'node', 'npm'])
  if (tasks.some(task => task.language === 'go')) needed.add('go')
  for (const tool of needed) {
    const found = await runShell(`command -v ${tool}`, { cwd: process.cwd(), timeoutMs: 5_000 })
    if (found.exitCode !== 0) problems.push({ message: `\`${tool}\` was not found on PATH` })
  }
  return problems
}

// ── The run ──────────────────────────────────────────────────────────────────

interface PlannedAttempt {
  task: Task
  attempt: number
}

/** Attempt 1 of every task, then attempt 2 of every task, so a run stopped early is still balanced. */
export function planAttempts(tasks: readonly Task[], repeat: number): PlannedAttempt[] {
  const planned: PlannedAttempt[] = []
  for (let attempt = 1; attempt <= repeat; attempt++) {
    for (const task of tasks) planned.push({ task, attempt })
  }
  return planned
}

function failedMeta(runId: string, task: Task, attempt: number, error: string): AttemptMeta {
  const at = nowIso()
  return { runId, taskId: task.id, attempt, outcome: 'dispatch-error', error, startedAt: at, endedAt: at, wallMs: 0 }
}

export async function executeRun(options: RunOptions): Promise<RunResult> {
  const { scenario, store, tasks } = options
  const log = options.log ?? (() => undefined)
  const env = options.env ?? process.env
  const credentials = options.credentials ?? resolveCredentials(env)
  const coroPath = resolveCoroPath(scenario)
  const caches = cachePaths(options.cacheDir ?? defaultCacheDir())
  for (const dir of Object.values(caches)) fs.mkdirSync(dir, { recursive: true })

  let judgeComplete: CompleteFn | null
  let judgeUnavailable: string | undefined
  if (options.judgeComplete !== undefined) judgeComplete = options.judgeComplete
  else if (!scenario.judge.enabled) judgeComplete = null
  else {
    const backend = selectJudgeBackend(credentials, env)
    judgeComplete = backend.complete
    if (!backend.complete) judgeUnavailable = backend.description
  }

  const coro = await describeCheckout(coroPath)
  const harness = await describeCheckout(PACKAGE_ROOT)
  const runId = store.newRunId(options.label)
  const hash = scenarioHash(scenario)
  const info: RunInfo = {
    runId,
    label: options.label,
    startedAt: nowIso(),
    scenario,
    scenarioHash: hash,
    ...(options.scenarioFile ? { scenarioFile: options.scenarioFile } : {}),
    overrides: options.overrides ?? [],
    coroPath,
    coroSha: coro.sha,
    coroDirty: coro.dirty,
    harnessSha: harness.sha,
    harnessDirty: harness.dirty,
    tasks: tasks.map(task => task.id),
  }
  store.writeRun(info)

  const workRoot = path.join(options.workRoot ?? defaultWorkRoot(), runId)
  options.onStart?.({ runId, workRoot })
  const records: IndexRecord[] = []
  const planned = planAttempts(tasks, scenario.repeat)
  log(`Run ${runId}: ${tasks.length} tasks x ${scenario.repeat} attempts, ${scenario.parallel} at a time`)

  await mapPool(planned, scenario.parallel, async ({ task, attempt }) => {
    if (options.signal?.aborted) return
    const label = `${task.id}-${attempt}`
    const artifactsDir = store.attemptDir(runId, task.id, attempt)
    const workDir = path.join(workRoot, label)
    fs.mkdirSync(artifactsDir, { recursive: true })
    log(`${label}: starting`)

    let meta: AttemptMeta | undefined
    let grade: Grade | undefined
    let metrics: Metrics | undefined
    try {
      const run = await runAttempt({
        runId,
        task,
        attemptNo: attempt,
        scenario,
        coroPath,
        credentials,
        artifactsDir,
        workDir,
        caches,
        env,
        ...(options.needsHumanGraceMs !== undefined ? { needsHumanGraceMs: options.needsHumanGraceMs } : {}),
        log,
      })
      meta = run.meta
      metrics = computeMetrics({ ...(run.job ? { job: run.job } : {}), timeline: run.timeline, outcome: run.meta.outcome })
      fs.writeFileSync(path.join(artifactsDir, 'metrics.json'), JSON.stringify(metrics, null, 2))
      grade = await gradeAttempt({
        task,
        scenario,
        run,
        env: isolatedEnv(env, run.workspace.home, caches),
        artifactsDir,
        judgeComplete,
        ...(judgeUnavailable ? { judgeUnavailable } : {}),
        log,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`${label}: harness error: ${message}`)
      // Keep what the job did if it got that far; only a failure before then is a dispatch error.
      if (!meta) {
        meta = failedMeta(runId, task, attempt, message)
        fs.writeFileSync(path.join(artifactsDir, 'attempt.json'), JSON.stringify(meta, null, 2))
      }
      fs.appendFileSync(path.join(artifactsDir, 'harness-error.log'), `${message}\n`)
    } finally {
      if (!options.keepWork) fs.rmSync(workDir, { recursive: true, force: true })
    }

    const record: IndexRecord = {
      runId,
      label: options.label,
      ts: nowIso(),
      coroSha: coro.sha,
      harnessSha: harness.sha,
      scenarioHash: hash,
      lane: scenario.lane,
      taskId: task.id,
      attempt,
      solved: grade?.solved ?? false,
      outcome: meta.outcome,
      expectedOutcomeMet: grade?.expectedOutcomeMet ?? false,
      costUsd: metrics?.costUsd ?? 0,
      wallMs: metrics?.wallMs ?? meta.wallMs,
      agentMs: metrics?.agentMs ?? 0,
      reviewWaitMs: metrics?.reviewWaitMs ?? 0,
      phaseRuns: metrics?.phaseRuns ?? 0,
      reworkRuns: metrics?.reworkRuns ?? 0,
      inputTokens: metrics?.inputTokens ?? 0,
      outputTokens: metrics?.outputTokens ?? 0,
      ...(grade?.judge ? { judge: { ...grade.judge.scores, mean: grade.judge.mean } } : {}),
    }
    records.push(record)
    store.appendIndex(record)
    log(
      `${label}: ${record.solved ? 'SOLVED' : 'not solved'} (${record.outcome}, ` +
        `$${record.costUsd.toFixed(3)}, ${Math.round(record.wallMs / 1000)}s)${grade ? ` - ${grade.reason}` : ''}`,
    )
  })

  const summary = summarize(records)
  const finished: RunInfo = { ...info, finishedAt: nowIso() }
  store.writeRun(finished)
  store.writeSummary(runId, summary)
  return { runId, info: finished, records, summary }
}
