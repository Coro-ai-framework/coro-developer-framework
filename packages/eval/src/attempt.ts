import fs from 'node:fs'
import path from 'node:path'
import type { Job } from '@coro-ai/cloud-protocol'
import { collectDelivery, deliveredDiff, saveJob } from './collect'
import { CoroClient } from './coro-client'
import { SimulatedReviewer } from './reviewer'
import { startRunner, type RunnerHandle } from './runner-process'
import { prepareWorkspace, isolatedEnv, redactConfigFile, type Caches, type Credentials, type Workspace } from './sandbox'
import { laneWorkflowPath, type Scenario } from './scenario'
import type { Task } from './tasks'
import type { AttemptMeta, AttemptOutcome, Delivery, Timeline } from './types'
import { nowIso } from './util'
import { watchJob } from './watch'

export interface AttemptContext {
  runId: string
  task: Task
  attemptNo: number
  scenario: Scenario
  /** Absolute path of the Coro checkout to run. */
  coroPath: string
  credentials: Credentials
  /** Kept results for this attempt: `results/<runId>/attempts/<task>-<n>/`. */
  artifactsDir: string
  /** Scratch space (home, sandbox, grade checkout). Lives outside the repository. */
  workDir: string
  caches: Caches
  /** Environment the harness was started with; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** How long a job may wait for a person before the attempt ends as `needs-human`. */
  needsHumanGraceMs?: number
  log?: (message: string) => void
}

export interface AttemptRun {
  meta: AttemptMeta
  job?: Job
  timeline: Timeline
  workspace: Workspace
  delivery: Delivery
  diff: string
}

export function attemptLabel(task: Task, attemptNo: number): string {
  return `${task.id}-${attemptNo}`
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

/**
 * One attempt, start to finish, up to but not including grading:
 *
 *   prepare the sandbox -> start an isolated runner -> dispatch -> watch
 *   (reviewer acting as needed) -> stop the runner -> collect the delivery.
 *
 * The runner is always stopped, and the config (which holds credentials) is
 * redacted, whatever happens in between.
 */
export async function runAttempt(ctx: AttemptContext): Promise<AttemptRun> {
  const log = ctx.log ?? (() => undefined)
  const { task, scenario } = ctx
  fs.mkdirSync(ctx.artifactsDir, { recursive: true })

  const startedAt = nowIso()
  const workspace = await prepareWorkspace({
    root: ctx.workDir,
    task,
    scenario,
    credentials: ctx.credentials,
  })

  const env = isolatedEnv(ctx.env ?? process.env, workspace.home, ctx.caches)
  let runner: RunnerHandle | undefined
  let job: Job | undefined
  let jobId: string | undefined
  let outcome: AttemptOutcome = 'dispatch-error'
  let error: string | undefined
  let timeline: Timeline = { dispatchedAt: startedAt, endedAt: startedAt, entries: [] }
  let port: number | undefined

  const logAbort = new AbortController()
  let logDone: Promise<void> = Promise.resolve()

  try {
    runner = await startRunner({
      coroPath: ctx.coroPath,
      configPath: workspace.configPath,
      cwd: workspace.home,
      env,
      logPath: path.join(ctx.artifactsDir, 'runner.log'),
      startupTimeoutMs: scenario.startupTimeoutSeconds * 1000,
    })
    port = runner.port
    const client = new CoroClient(runner.baseUrl)

    const dispatched = await client.dispatch({
      workflowPath: laneWorkflowPath(scenario.lane),
      type: 'job',
      repo: workspace.sandbox,
      description: task.description,
    })
    jobId = dispatched.jobId
    log(`${attemptLabel(task, ctx.attemptNo)}: dispatched job ${jobId} on port ${runner.port}`)

    const logStream = fs.createWriteStream(path.join(ctx.artifactsDir, 'job.log'))
    logDone = client
      .streamLog(jobId, line => logStream.write(`${line}\n`), logAbort.signal)
      .finally(() => logStream.end())

    const reviewer = new SimulatedReviewer({
      home: workspace.home,
      sandbox: workspace.sandbox,
      approveAfterMs: scenario.reviewer.approveAfterSeconds * 1000,
    })

    const watched = await watchJob({
      client,
      reviewer,
      jobId,
      timeoutMs: task.timeoutMinutes * 60_000,
      pollMs: scenario.pollIntervalSeconds * 1000,
      needsHumanGraceMs: ctx.needsHumanGraceMs ?? 30_000,
      runnerAlive: () => !runner!.hasExited(),
    })
    outcome = watched.outcome
    error = watched.error
    timeline = watched.timeline
    job = watched.job

    // One last look, so a PR the job merged in its final moments is merged here too,
    // and the record saved is the settled one rather than a poll that may be stale.
    if (!runner.hasExited()) {
      try {
        job = await client.getJob(jobId)
      } catch {
        // keep the last polled record
      }
    }
    if (job) {
      try {
        await reviewer.tick(job)
      } catch {
        // best effort
      }
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
    log(`${attemptLabel(task, ctx.attemptNo)}: ${error}`)
    timeline = { ...timeline, endedAt: nowIso() }
  } finally {
    logAbort.abort()
    await logDone.catch(() => undefined)
    if (runner) await runner.stop()
    redactConfigFile(workspace.configPath)
  }

  const delivery = await collectDelivery({ sandbox: workspace.sandbox, baseSha: workspace.baseSha, job })
  const diff = await deliveredDiff(workspace.sandbox, delivery)
  fs.writeFileSync(path.join(ctx.artifactsDir, 'diff.patch'), diff)
  if (job) await saveJob(job, ctx.artifactsDir)
  writeJson(path.join(ctx.artifactsDir, 'timeline.json'), timeline)

  const endedAt = nowIso()
  const meta: AttemptMeta = {
    runId: ctx.runId,
    taskId: task.id,
    attempt: ctx.attemptNo,
    outcome,
    ...(job?.status ? { jobStatus: job.status } : {}),
    ...(jobId ? { jobId } : {}),
    ...(error ? { error } : {}),
    startedAt,
    endedAt,
    wallMs: Math.max(0, Date.parse(timeline.endedAt) - Date.parse(timeline.dispatchedAt)) || 0,
    ...(port !== undefined ? { port } : {}),
    delivery,
  }
  writeJson(path.join(ctx.artifactsDir, 'attempt.json'), meta)

  return { meta, ...(job ? { job } : {}), timeline, workspace, delivery, diff }
}
