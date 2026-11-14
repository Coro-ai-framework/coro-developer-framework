import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Command, InvalidArgumentError } from 'commander'
import { serveDashboard } from './dashboard'
import { isolatedEnv, cachePaths } from './sandbox'
import { killAllRunnersSync, stopAllRunners } from './runner-process'
import {
  compareRuns,
  historyRows,
  parseMetric,
  renderComparison,
  renderHistory,
  renderReport,
  renderTable,
  summarize,
  METRIC_KEYS,
  type RenderFormat,
} from './report'
import { defaultCacheDir, defaultWorkRoot, executeRun, preflight } from './run'
import { loadScenario, listScenarios, resolveCoroPath, scenarioHash } from './scenario'
import { selectJudgeBackend } from './grade/judge'
import { describeCredentials, resolveCredentials, type Credentials } from './sandbox'
import { ResultStore, RESULTS_DIR } from './store'
import { loadTask, selectTasks, TASKS_DIR, type Task } from './tasks'
import { validateTask } from './validate'
import { killAllShellsSync } from './util'

function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function positiveInt(value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError('must be a whole number, 1 or more')
  return parsed
}

/** Local wall-clock time, the same clock the run id is stamped with. */
function clockTime(date: Date = new Date()): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

function progress(message: string): void {
  console.error(`[${clockTime()}] ${message}`)
}

/** Load every task directory, reporting the ones that do not parse instead of stopping at the first. */
function loadTaskDirs(tasksDir: string): { tasks: Task[]; errors: Array<{ dir: string; message: string }> } {
  const tasks: Task[] = []
  const errors: Array<{ dir: string; message: string }> = []
  if (!fs.existsSync(tasksDir)) return { tasks, errors: [{ dir: tasksDir, message: 'tasks directory does not exist' }] }
  for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(tasksDir, entry.name)
    if (!fs.existsSync(path.join(dir, 'task.yaml'))) continue
    try {
      tasks.push(loadTask(dir))
    } catch (error) {
      errors.push({ dir, message: error instanceof Error ? error.message : String(error) })
    }
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id))
  return { tasks, errors }
}

function loadSelectedTasks(tasksDir: string, selectors: string | undefined): Task[] {
  const { tasks, errors } = loadTaskDirs(tasksDir)
  if (errors.length > 0) throw new Error(errors.map(e => e.message).join('\n'))
  const selected = selectTasks(tasks, selectors)
  if (selected.length === 0) throw new Error(`No tasks found in ${tasksDir}`)
  return selected
}

/** `--md` alone prints Markdown; `--md file` writes it. Without the flag, plain text goes to the terminal. */
function emit(render: (format: RenderFormat) => string, md: boolean | string | undefined): void {
  if (typeof md === 'string') {
    const file = path.resolve(md)
    fs.writeFileSync(file, `${render('markdown')}\n`)
    console.log(render('text'))
    console.error(`\nMarkdown written to ${file}`)
    return
  }
  console.log(render(md ? 'markdown' : 'text'))
}

export function buildProgram(): Command {
  const program = new Command('coro-eval')
  program
    .description('Evaluate Coro from the outside: dispatch jobs under a scenario, grade the result, keep every run.')
    .showHelpAfterError()

  // ── run ────────────────────────────────────────────────────────────────────
  program
    .command('run')
    .description('Run a scenario over a set of tasks and record the results')
    .option('-s, --scenario <name|path>', 'scenario in scenarios/ or a file path', 'baseline')
    .option('-t, --tasks <selectors>', 'comma-separated globs on id, size/id or language/id (default: all)')
    .option('-r, --repeat <n>', 'attempts per task (overrides the scenario)', positiveInt)
    .option('-p, --parallel <n>', 'attempts in flight at once (overrides the scenario)', positiveInt)
    .option('--set <key=value>', 'override any scenario value, e.g. lane=fast or models.coding=claude-sonnet-5-5 (repeatable)', collect, [])
    .option('-l, --label <text>', 'name for this run (default: the scenario name)')
    .option('--tasks-dir <dir>', 'where tasks live', TASKS_DIR)
    .option('--results-dir <dir>', 'where results are kept', RESULTS_DIR)
    .option('--work-dir <dir>', 'parent of the per-attempt scratch directories (default: under the OS temp dir)')
    .option('--keep-work', 'keep each attempt\'s scratch directory after grading')
    .option('--no-judge', 'skip the LLM judge')
    .option('--dry-run', 'print what would run and check prerequisites, without running anything')
    .action(async (opts: RunFlags) => {
      const overrides = [...opts.set, ...(opts.judge === false ? ['judge.enabled=false'] : [])]
      const { scenario, file } = loadScenario(opts.scenario, {
        flags: { repeat: opts.repeat, parallel: opts.parallel },
        overrides,
      })
      const tasks = loadSelectedTasks(path.resolve(opts.tasksDir), opts.tasks)
      const label = opts.label ?? path.basename(file, path.extname(file))
      const problems = await preflight(scenario, tasks)

      if (opts.dryRun) {
        // A real run refuses to start without credentials, so a dry run reports it as a blocker too.
        try {
          resolveCredentials()
        } catch (error) {
          problems.push({ message: error instanceof Error ? error.message : String(error) })
        }
        printPlan({ scenarioFile: file, scenario, tasks, label, overrides, problems })
        process.exitCode = problems.length > 0 ? 1 : 0
        return
      }

      for (const problem of problems) console.error(`error: ${problem.message}`)
      if (problems.length > 0) {
        process.exitCode = 1
        return
      }
      // Fail before anything is started if there is nothing to authenticate with, and say which one is used.
      const credentials = resolveCredentials()
      progress(`Credentials: ${describeCredentials(credentials)}`)
      if (scenario.judge.enabled) {
        const judge = selectJudgeBackend(credentials)
        progress(
          judge.complete
            ? `Judge: ${scenario.judge.model} via ${judge.description}`
            : `The judge will be skipped: ${judge.description} (tests and process metrics are still recorded).`,
        )
      }

      const store = new ResultStore(path.resolve(opts.resultsDir))
      const controller = new AbortController()
      let workRoot: string | undefined
      const interrupted = (signal: string): void => {
        console.error(`\n${signal}: stopping runners and discarding unfinished attempts...`)
        controller.abort()
        killAllRunnersSync()
        killAllShellsSync()
        if (workRoot && !opts.keepWork) fs.rmSync(workRoot, { recursive: true, force: true })
        process.exit(130)
      }
      process.once('SIGINT', () => interrupted('SIGINT'))
      process.once('SIGTERM', () => interrupted('SIGTERM'))

      const result = await executeRun({
        scenario,
        scenarioFile: file,
        overrides,
        label,
        tasks,
        store,
        ...(opts.workDir ? { workRoot: path.resolve(opts.workDir) } : {}),
        keepWork: opts.keepWork === true,
        signal: controller.signal,
        onStart: started => {
          workRoot = started.workRoot
        },
        log: progress,
      })
      if (workRoot && !opts.keepWork) fs.rmSync(workRoot, { recursive: true, force: true })

      console.log('')
      console.log(renderReport(result.info, result.summary))
      console.log(`\nResults: ${store.runDir(result.runId)}`)
    })

  // ── dashboard ──────────────────────────────────────────────────────────────
  program
    .command('dashboard')
    .description('Serve a small local dashboard for runs and test results')
    .option('--results-dir <dir>', 'where results are kept', RESULTS_DIR)
    .option('--host <host>', 'interface to bind', '127.0.0.1')
    .option('--port <n>', 'port to bind', positiveInt, 4310)
    .action(async (opts: { resultsDir: string; host: string; port: number }) => {
      await serveDashboard({
        resultsDir: path.resolve(opts.resultsDir),
        host: opts.host,
        port: opts.port,
      })
    })

  // ── report ─────────────────────────────────────────────────────────────────
  program
    .command('report [run]')
    .description('Show a run: per-task solve rate, pass@k / pass^k, cost, time, rework and judge scores')
    .option('--results-dir <dir>', 'where results are kept', RESULTS_DIR)
    .option('--md [file]', 'Markdown instead of plain text; with a file name, write it there')
    .action((reference: string | undefined, opts: { resultsDir: string; md?: boolean | string }) => {
      const store = new ResultStore(path.resolve(opts.resultsDir))
      const runId = store.resolveRunId(reference ?? 'latest')
      const info = store.readRun(runId)
      const records = store.readRunRecords(runId)
      if (records.length === 0) throw new Error(`Run ${runId} has no recorded attempts`)
      const summary = summarize(records)
      emit(format => renderReport(info, summary, format), opts.md)
    })

  // ── compare ────────────────────────────────────────────────────────────────
  program
    .command('compare <a> <b>')
    .description('Compare two runs task by task (deltas are B minus A); differences inside the run-to-run spread are marked noise')
    .option('--results-dir <dir>', 'where results are kept', RESULTS_DIR)
    .option('--md [file]', 'Markdown instead of plain text; with a file name, write it there')
    .action((a: string, b: string, opts: { resultsDir: string; md?: boolean | string }) => {
      const store = new ResultStore(path.resolve(opts.resultsDir))
      const idA = store.resolveRunId(a)
      const idB = store.resolveRunId(b)
      const comparison = compareRuns(store.readRunRecords(idA), store.readRunRecords(idB))
      if (comparison.tasks.length === 0) throw new Error('The two runs have no task in common.')
      const infoA = store.readRun(idA)
      const infoB = store.readRun(idB)
      emit(
        format =>
          renderComparison({ id: idA, label: infoA.label }, { id: idB, label: infoB.label }, comparison, format),
        opts.md,
      )
    })

  // ── history ────────────────────────────────────────────────────────────────
  program
    .command('history')
    .description('Trend of a metric across every recorded run')
    .option('--task <id>', 'only this task')
    .option('--metric <name>', `one of ${METRIC_KEYS.join(', ')}`, 'solveRate')
    .option('--results-dir <dir>', 'where results are kept', RESULTS_DIR)
    .option('--md [file]', 'Markdown instead of plain text; with a file name, write it there')
    .action((opts: { task?: string; metric: string; resultsDir: string; md?: boolean | string }) => {
      const store = new ResultStore(path.resolve(opts.resultsDir))
      const metric = parseMetric(opts.metric)
      const rows = historyRows(store.readIndex(), { metric, ...(opts.task ? { task: opts.task } : {}) })
      if (rows.length === 0) throw new Error(opts.task ? `No recorded attempts for task "${opts.task}"` : 'No recorded runs yet')
      emit(format => renderHistory(rows, { metric, ...(opts.task ? { task: opts.task } : {}) }, format), opts.md)
    })

  // ── tasks ──────────────────────────────────────────────────────────────────
  const tasksCommand = program.command('tasks').description('Inspect and validate the task set')

  tasksCommand
    .command('list', { isDefault: true })
    .description('List the tasks')
    .option('--tasks-dir <dir>', 'where tasks live', TASKS_DIR)
    .action((opts: { tasksDir: string }) => {
      const { tasks, errors } = loadTaskDirs(path.resolve(opts.tasksDir))
      console.log(
        renderTable(
          {
            headers: ['id', 'size', 'language', 'expect', 'timeout', 'scope'],
            rows: tasks.map(t => [t.id, t.size, t.language, t.expect, `${t.timeoutMinutes}m`, t.grade.scope.join(' ') || '-']),
          },
          'text',
        ),
      )
      for (const error of errors) console.error(`\ninvalid task in ${error.dir}:\n${error.message}`)
      if (errors.length > 0) process.exitCode = 1
    })

  tasksCommand
    .command('validate [selectors]')
    .description('Check each task against its reference patch: hidden tests fail without it and pass with it (no model involved)')
    .option('--tasks-dir <dir>', 'where tasks live', TASKS_DIR)
    .option('--work-dir <dir>', 'scratch parent (default: under the OS temp dir)')
    .action(async (selectors: string | undefined, opts: { tasksDir: string; workDir?: string }) => {
      const { tasks, errors } = loadTaskDirs(path.resolve(opts.tasksDir))
      let failed = errors.length
      for (const error of errors) console.error(`INVALID ${error.dir}\n${error.message}\n`)

      const workRoot = path.join(opts.workDir ? path.resolve(opts.workDir) : defaultWorkRoot(), `validate-${process.pid}`)
      const home = path.join(workRoot, 'home')
      fs.mkdirSync(home, { recursive: true })
      const caches = cachePaths(defaultCacheDir())
      for (const dir of Object.values(caches)) fs.mkdirSync(dir, { recursive: true })
      const env = isolatedEnv(process.env, home, caches)
      process.once('SIGINT', () => {
        killAllShellsSync()
        process.exit(130)
      })

      try {
        for (const task of selectTasks(tasks, selectors)) {
          progress(`validating ${task.id}`)
          const result = await validateTask(task, { env, workRoot, log: progress })
          console.log(`${result.ok ? 'OK     ' : 'PROBLEM'} ${task.id}`)
          for (const note of result.notes) console.log(`         ${note}`)
          for (const problem of result.problems) console.log(`         ! ${problem.split('\n').join('\n           ')}`)
          if (!result.ok) failed++
        }
      } finally {
        fs.rmSync(workRoot, { recursive: true, force: true })
      }
      if (failed > 0) process.exitCode = 1
    })

  // ── scenarios ──────────────────────────────────────────────────────────────
  program
    .command('scenarios')
    .description('List the scenarios in scenarios/')
    .action(() => {
      for (const name of listScenarios()) {
        const { scenario } = loadScenario(name)
        console.log(`${name}\tlane=${scenario.lane} repeat=${scenario.repeat} hash=${scenarioHash(scenario)} coro=${resolveCoroPath(scenario)}`)
      }
    })

  return program
}

interface RunFlags {
  scenario: string
  tasks?: string
  repeat?: number
  parallel?: number
  set: string[]
  label?: string
  tasksDir: string
  resultsDir: string
  workDir?: string
  keepWork?: boolean
  judge?: boolean
  dryRun?: boolean
}

function printPlan(plan: {
  scenarioFile: string
  scenario: ReturnType<typeof loadScenario>['scenario']
  tasks: Task[]
  label: string
  overrides: string[]
  problems: Array<{ message: string }>
}): void {
  const { scenario } = plan
  let resolved: Credentials | undefined
  let credentials: string
  try {
    resolved = resolveCredentials()
    credentials = describeCredentials(resolved)
  } catch {
    credentials = 'MISSING (set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN)'
  }
  const judge = scenario.judge.enabled ? selectJudgeBackend(resolved) : undefined

  console.log(`Scenario   ${plan.scenarioFile}  (hash ${scenarioHash(scenario)})`)
  console.log(`Label      ${plan.label}`)
  if (plan.overrides.length > 0) console.log(`Overrides  ${plan.overrides.join('  ')}`)
  console.log(`Coro       ${resolveCoroPath(scenario)}`)
  console.log(`Lane       ${scenario.lane}`)
  console.log(`Models     ${Object.keys(scenario.models).length > 0 ? JSON.stringify(scenario.models) : 'runner defaults'}`)
  console.log(`Overlay    ${scenario.tenantOverlayDir ?? 'none'}`)
  console.log(`Attempts   ${plan.tasks.length} tasks x ${scenario.repeat} = ${plan.tasks.length * scenario.repeat}, ${scenario.parallel} at a time`)
  console.log(
    `Judge      ${judge ? `${scenario.judge.model} x${scenario.judge.samples}, ${judge.complete ? 'via' : 'will be skipped:'} ${judge.description}` : 'off'}`,
  )
  console.log(`Credentials ${credentials}`)
  console.log(`Scratch    ${path.join(os.tmpdir(), 'coro-eval')}`)
  console.log('')
  console.log(
    renderTable(
      {
        headers: ['task', 'size', 'language', 'expect', 'timeout'],
        rows: plan.tasks.map(t => [t.id, t.size, t.language, t.expect, `${t.timeoutMinutes}m`]),
      },
      'text',
    ),
  )
  if (plan.problems.length > 0) {
    console.log('\nProblems:')
    for (const problem of plan.problems) console.log(`  - ${problem.message}`)
  } else {
    console.log('\nPrerequisites OK.')
  }
}

export async function main(argv: string[] = process.argv): Promise<void> {
  process.on('exit', () => {
    killAllRunnersSync()
    killAllShellsSync()
  })
  try {
    await buildProgram().parseAsync(argv)
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  } finally {
    await stopAllRunners()
  }
}
