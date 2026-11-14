import fs from 'node:fs'
import path from 'node:path'
import type { AttemptRun } from '../attempt'
import { deliveredNumstat } from '../collect'
import type { Scenario } from '../scenario'
import type { Task } from '../tasks'
import type { AttemptOutcome } from '../types'
import type { ShellResult } from '../util'
import { runJudge, type CompleteFn, type JudgeResult } from './judge'
import { gradeScope, parseNumstat, patchNumstat, type ScopeGrade } from './scope'
import { gradeTests, type TestsGrade } from './tests'

export interface Grade {
  /** The one bit every report is built on. See {@link gradeAttempt} for what earns it. */
  solved: boolean
  /** One line saying why `solved` is what it is. */
  reason: string
  delivered: boolean
  /** The job ended the way the task expected: `complete` for `pr`, a stop-and-ask for `escalate`. */
  expectedOutcomeMet: boolean
  tests?: TestsGrade
  scope?: ScopeGrade
  judge?: JudgeResult
  /** Why there is no `judge`, when there is not. */
  judgeSkipped?: string
}

/** A job that escalated, or parked waiting for a person: it stopped to ask instead of guessing. */
export function askedForHelp(outcome: AttemptOutcome): boolean {
  return outcome === 'escalated' || outcome === 'needs-human'
}

export function outcomeMeetsExpectation(expect: Task['expect'], outcome: AttemptOutcome): boolean {
  return expect === 'escalate' ? askedForHelp(outcome) : outcome === 'complete'
}

export interface GradeAttemptArgs {
  task: Task
  scenario: Scenario
  run: AttemptRun
  /** Environment for the task's commands (isolated HOME, shared package caches). */
  env: NodeJS.ProcessEnv
  /** Where `grade.json`, `grade.log` and `judge.json` are written. */
  artifactsDir: string
  /** Null when the judge cannot run. */
  judgeComplete: CompleteFn | null
  /** Why `judgeComplete` is null, recorded in `grade.json`. */
  judgeUnavailable?: string
  log?: (message: string) => void
}

function describeTest(label: string, run: { passed: boolean; counts?: { passed: number; failed: number; total: number } } | undefined): string {
  if (!run) return `${label}: not run`
  const counts = run.counts ? ` (${run.counts.passed}/${run.counts.total} passed)` : ''
  return `${label}: ${run.passed ? 'PASSED' : 'FAILED'}${counts}`
}

function automatedResultsText(task: Task, outcome: AttemptOutcome, tests: TestsGrade | undefined, scope: ScopeGrade | undefined): string {
  const lines = [`Job outcome: ${outcome}`]
  if (tests) {
    if (tests.setupFailed) lines.push('Setup (dependency install) FAILED, so no tests could run.')
    lines.push(describeTest('Hidden tests', tests.hidden))
    lines.push(describeTest('Existing tests', tests.existing))
    for (const check of tests.checks) {
      lines.push(`Check "${check.command}": ${check.exitCode === 0 && !check.timedOut ? 'ok' : 'FAILED'}`)
    }
  }
  if (scope) {
    lines.push(
      `Change size: ${scope.filesChanged} files, +${scope.linesAdded}/-${scope.linesRemoved} lines` +
        (scope.reference
          ? ` (reference: ${scope.reference.filesChanged} files, +${scope.reference.linesAdded}/-${scope.reference.linesRemoved})`
          : ''),
    )
    if (scope.outOfScopeFiles.length > 0) lines.push(`Files outside the allowed scope: ${scope.outOfScopeFiles.join(', ')}`)
  }
  if (task.grade.scope.length > 0) lines.push(`Allowed scope: ${task.grade.scope.join(', ')}`)
  return lines.join('\n')
}

/**
 * Grade one finished attempt.
 *
 *   `expect: pr`        solved when something was delivered and both the hidden
 *                       tests and the task's own tests pass on it. Lint and
 *                       typecheck results are recorded but do not decide this.
 *   `expect: escalate`  solved when the job stopped and asked for help
 *                       (escalated, or parked waiting for a person) instead of guessing.
 *
 * The outcome (`complete`, `timeout`, ...) is recorded separately and is not
 * part of "solved" for `pr` tasks: code that passes the hidden tests passes
 * them. Reports show the outcome mix so a solved-but-timed-out attempt is
 * visible rather than hidden.
 */
export async function gradeAttempt(args: GradeAttemptArgs): Promise<Grade> {
  const { task, scenario, run } = args
  const outcome = run.meta.outcome
  const delivered = run.delivery.delivered
  const expectedOutcomeMet = outcomeMeetsExpectation(task.expect, outcome)
  const logPath = path.join(args.artifactsDir, 'grade.log')
  fs.writeFileSync(logPath, '')

  let grade: Grade

  if (task.expect === 'escalate') {
    const asked = askedForHelp(outcome)
    grade = {
      solved: asked,
      delivered,
      expectedOutcomeMet,
      reason: asked
        ? `stopped and asked for help (${outcome}) instead of guessing`
        : delivered
          ? `shipped a change for a task that should have been escalated (outcome: ${outcome})`
          : `did not escalate (outcome: ${outcome})`,
    }
    if (delivered) grade.scope = await scopeFor(task, run)
    grade.judgeSkipped = 'not applicable to an escalate task'
  } else if (!delivered) {
    grade = {
      solved: false,
      delivered: false,
      expectedOutcomeMet,
      reason: `nothing delivered (outcome: ${outcome})${run.meta.error ? `: ${run.meta.error}` : ''}`,
      judgeSkipped: 'nothing was delivered',
    }
  } else {
    const tests = await gradeTests({
      task,
      workspace: run.workspace,
      env: args.env,
      onOutput: (title: string, result: ShellResult) => {
        fs.appendFileSync(logPath, `\n===== ${title}: ${result.command} (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}) =====\n${result.output}\n`)
      },
    })
    const scope = await scopeFor(task, run)
    const solved = !tests.setupFailed && tests.hiddenPassed && tests.existingPassed

    grade = {
      solved,
      delivered,
      expectedOutcomeMet,
      reason: solved
        ? 'hidden and existing tests passed'
        : tests.setupFailed
          ? 'setup failed, so the delivered code could not be tested'
          : [
              !tests.hiddenPassed ? 'hidden tests failed' : undefined,
              !tests.existingPassed ? 'existing tests failed' : undefined,
            ]
              .filter(Boolean)
              .join(' and '),
      tests,
      scope,
    }

    if (!scenario.judge.enabled) {
      grade.judgeSkipped = 'judge disabled in the scenario'
    } else if (!args.judgeComplete) {
      grade.judgeSkipped = `no judge available: ${args.judgeUnavailable ?? 'no credentials'}`
    } else {
      try {
        const referencePatch = fs.existsSync(task.referencePatchPath) ? fs.readFileSync(task.referencePatchPath, 'utf-8') : ''
        grade.judge = await runJudge({
          complete: args.judgeComplete,
          model: scenario.judge.model,
          samples: scenario.judge.samples,
          input: {
            ticket: task.description,
            diff: run.diff,
            referencePatch,
            automatedResults: automatedResultsText(task, outcome, tests, scope),
          },
        })
        fs.writeFileSync(path.join(args.artifactsDir, 'judge.json'), JSON.stringify(grade.judge, null, 2))
      } catch (error) {
        grade.judgeSkipped = `judge failed: ${error instanceof Error ? error.message : String(error)}`
        args.log?.(`${task.id}: ${grade.judgeSkipped}`)
      }
    }
  }

  fs.writeFileSync(path.join(args.artifactsDir, 'grade.json'), JSON.stringify(grade, null, 2))
  return grade
}

async function scopeFor(task: Task, run: AttemptRun): Promise<ScopeGrade> {
  const numstat = parseNumstat(await deliveredNumstat(run.workspace.sandbox, run.delivery))
  const reference = fs.existsSync(task.referencePatchPath)
    ? await patchNumstat(task.referencePatchPath, run.workspace.root)
    : undefined
  return gradeScope({ numstat, scope: task.grade.scope, ...(reference ? { referenceNumstat: reference } : {}) })
}
