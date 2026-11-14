import fs from 'node:fs'
import path from 'node:path'
import { DELIVERED_BRANCH } from '../collect'
import { git } from '../git'
import type { Workspace } from '../sandbox'
import type { Task } from '../tasks'
import { runShell, type ShellResult } from '../util'

/**
 * Grade by running things: the task's hidden tests, its own tests, and its
 * lint/typecheck commands, in a fresh checkout of what the job delivered.
 *
 * The hidden tests are copied in only now. The agent never saw them and could
 * not have shaped its solution around their exact assertions.
 */

export interface CommandRun {
  command: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  /** The end of the output (the part that says what failed). The full text is in `grade.log`. */
  outputTail: string
  outputBytes: number
}

export interface TestCounts {
  passed: number
  failed: number
  total: number
}

export interface TestRun extends CommandRun {
  counts?: TestCounts
  passed: boolean
}

export interface TestsGrade {
  /** False when there was nothing to check out (no delivery). */
  checkedOut: boolean
  setup?: CommandRun
  /** `setup` ran and failed, so no test result below means anything. */
  setupFailed: boolean
  hidden?: TestRun
  existing?: TestRun
  checks: CommandRun[]
  hiddenPassed: boolean
  /** True when the task declares no existing tests. */
  existingPassed: boolean
  /** Every check command exited 0. Recorded, but not part of "solved". */
  checksPassed: boolean
}

const OUTPUT_TAIL_CHARS = 4_000
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

export function toCommandRun(result: ShellResult): CommandRun {
  const clean = result.output.replace(ANSI, '')
  return {
    command: result.command,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    outputTail: clean.length > OUTPUT_TAIL_CHARS ? clean.slice(clean.length - OUTPUT_TAIL_CHARS) : clean,
    outputBytes: result.outputBytes,
  }
}

/**
 * Read pass/fail counts out of test-runner output. Understands vitest/jest
 * summaries, `go test -v`, and node's built-in test runner. Returns undefined
 * for anything else, in which case the exit code alone decides.
 */
export function parseTestCounts(output: string): TestCounts | undefined {
  const text = output.replace(ANSI, '')

  // vitest: "Tests  1 failed | 12 passed (13)"
  const vitest = text.match(/^\s*Tests\s+(.+)$/m)
  if (vitest) {
    const line = vitest[1]!
    const failed = Number(line.match(/(\d+)\s+failed/)?.[1] ?? 0)
    const passed = Number(line.match(/(\d+)\s+passed/)?.[1] ?? 0)
    const total = Number(line.match(/\((\d+)\)/)?.[1] ?? failed + passed)
    return { passed, failed, total }
  }

  // node:test: "ℹ tests 3" / "ℹ pass 3" / "ℹ fail 0" (spec reporter) or "# tests 3" (TAP, the default off a terminal in Node 20)
  const nodeTests = text.match(/^(?:ℹ|#) tests (\d+)\s*$/m)
  if (nodeTests) {
    return {
      total: Number(nodeTests[1]),
      passed: Number(text.match(/^(?:ℹ|#) pass (\d+)\s*$/m)?.[1] ?? 0),
      failed: Number(text.match(/^(?:ℹ|#) fail (\d+)\s*$/m)?.[1] ?? 0),
    }
  }

  // go test -v: "--- PASS: TestName (0.00s)", indented for subtests
  const goPass = (text.match(/^\s*--- PASS:/gm) ?? []).length
  const goFail = (text.match(/^\s*--- FAIL:/gm) ?? []).length
  if (goPass + goFail > 0) return { passed: goPass, failed: goFail, total: goPass + goFail }

  return undefined
}

export function toTestRun(result: ShellResult): TestRun {
  const run = toCommandRun(result)
  const counts = parseTestCounts(result.output)
  // `go test` and friends exit 0 when they found no tests; that is not a pass.
  const ranSomething = counts === undefined || counts.total > 0
  return {
    ...run,
    ...(counts ? { counts } : {}),
    passed: result.exitCode === 0 && !result.timedOut && ranSomething,
  }
}

export interface GradeTestsArgs {
  task: Task
  workspace: Workspace
  env: NodeJS.ProcessEnv
  setupTimeoutMs?: number
  commandTimeoutMs?: number
  /** Gets every command and its full output, for `grade.log`. */
  onOutput?: (title: string, result: ShellResult) => void
}

/** Clone the delivered commit into `workspace.grade` and add the hidden tests. */
export async function checkoutDelivered(task: Task, workspace: Workspace): Promise<string> {
  fs.rmSync(workspace.grade, { recursive: true, force: true })
  await git(
    ['clone', '--quiet', '--no-hardlinks', '--branch', DELIVERED_BRANCH, workspace.sandbox, workspace.grade],
    path.dirname(workspace.grade),
  )
  if (fs.existsSync(task.hiddenTestsDir)) {
    const target = path.join(workspace.grade, task.grade.hiddenDir)
    fs.rmSync(target, { recursive: true, force: true })
    fs.cpSync(task.hiddenTestsDir, target, { recursive: true })
  }
  return workspace.grade
}

export async function gradeTests(args: GradeTestsArgs): Promise<TestsGrade> {
  const { task, workspace, env } = args
  const spec = task.grade
  const checkout = await checkoutDelivered(task, workspace)
  const options = { cwd: checkout, env }
  const record = (title: string, result: ShellResult): ShellResult => {
    args.onOutput?.(title, result)
    return result
  }

  const failedAll = (setup: CommandRun): TestsGrade => ({
    checkedOut: true,
    setup,
    setupFailed: true,
    checks: [],
    hiddenPassed: false,
    existingPassed: false,
    checksPassed: false,
  })

  let setup: CommandRun | undefined
  if (spec.setup) {
    const result = record('setup', await runShell(spec.setup, { ...options, timeoutMs: args.setupTimeoutMs ?? 15 * 60_000 }))
    setup = toCommandRun(result)
    if (result.exitCode !== 0 || result.timedOut) return failedAll(setup)
  }

  const commandTimeout = args.commandTimeoutMs ?? 10 * 60_000
  const hidden = spec.hiddenTests
    ? toTestRun(record('hidden tests', await runShell(spec.hiddenTests, { ...options, timeoutMs: commandTimeout })))
    : undefined
  const existing = spec.existingTests
    ? toTestRun(record('existing tests', await runShell(spec.existingTests, { ...options, timeoutMs: commandTimeout })))
    : undefined

  const checks: CommandRun[] = []
  for (const command of spec.checks) {
    checks.push(toCommandRun(record(`check: ${command}`, await runShell(command, { ...options, timeoutMs: commandTimeout }))))
  }

  return {
    checkedOut: true,
    ...(setup ? { setup } : {}),
    setupFailed: false,
    ...(hidden ? { hidden } : {}),
    ...(existing ? { existing } : {}),
    checks,
    hiddenPassed: hidden?.passed ?? false,
    existingPassed: existing ? existing.passed : true,
    checksPassed: checks.every(check => check.exitCode === 0 && !check.timedOut),
  }
}
