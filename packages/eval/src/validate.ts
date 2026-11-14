import fs from 'node:fs'
import path from 'node:path'
import { matchesAny } from './glob'
import { git, gitResult } from './git'
import { patchNumstat } from './grade/scope'
import { toTestRun, type TestRun } from './grade/tests'
import type { Task } from './tasks'
import { runShell, tailLines } from './util'

/**
 * A task is only a benchmark if its tests can tell a solution from no
 * solution. `validateTask` checks that against the task's own reference patch,
 * with no model involved:
 *
 *   the fixture as given        hidden tests FAIL, existing tests pass
 *   fixture + reference.patch   hidden tests PASS, existing tests pass
 *
 * Run it after writing or editing a task, and in CI for this package. A task
 * whose hidden tests already pass on the fixture scores every do-nothing
 * attempt as solved.
 */

export interface TaskValidation {
  taskId: string
  ok: boolean
  /** Things that make the task unusable. */
  problems: string[]
  /** Things worth knowing that do not. */
  notes: string[]
}

function copyFixture(from: string, to: string): void {
  fs.cpSync(from, to, {
    recursive: true,
    filter: src => {
      const name = path.basename(src)
      return name !== '.git' && name !== 'node_modules'
    },
  })
}

function describe(label: string, run: TestRun): string {
  const counts = run.counts ? ` (${run.counts.passed}/${run.counts.total} passed)` : ''
  return `${label}: ${run.passed ? 'passed' : 'failed'}${counts}`
}

export interface ValidateOptions {
  /** Environment for the task's commands. */
  env: NodeJS.ProcessEnv
  /** Scratch parent; the checkout is removed afterwards. */
  workRoot: string
  keep?: boolean
  setupTimeoutMs?: number
  commandTimeoutMs?: number
  log?: (message: string) => void
}

export async function validateTask(task: Task, options: ValidateOptions): Promise<TaskValidation> {
  const problems: string[] = []
  const notes: string[] = []
  const finish = (): TaskValidation => ({ taskId: task.id, ok: problems.length === 0, problems, notes })

  if (task.expect === 'escalate') {
    notes.push('expects an escalation: nothing to run. Check by hand that the description really is ambiguous or unsafe.')
    return finish()
  }

  const root = path.join(options.workRoot, `validate-${task.id}-${process.pid}`)
  const checkout = path.join(root, 'checkout')
  const setupTimeout = options.setupTimeoutMs ?? 15 * 60_000
  const commandTimeout = options.commandTimeoutMs ?? 10 * 60_000
  const spec = task.grade
  const run = (command: string, timeoutMs: number) => runShell(command, { cwd: checkout, env: options.env, timeoutMs })

  try {
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(root, { recursive: true })
    copyFixture(task.repoDir, checkout)
    await git(['init', '-q', '-b', 'main'], checkout)
    await git(['add', '-A'], checkout)
    await git(['-c', 'user.name=eval', '-c', 'user.email=eval@example.invalid', 'commit', '-q', '-m', 'fixture'], checkout)

    const hiddenTarget = path.join(checkout, spec.hiddenDir)
    fs.cpSync(task.hiddenTestsDir, hiddenTarget, { recursive: true })

    const setup = async (when: string): Promise<boolean> => {
      if (!spec.setup) return true
      options.log?.(`${task.id}: setup (${when})`)
      const result = await run(spec.setup, setupTimeout)
      if (result.exitCode === 0 && !result.timedOut) return true
      problems.push(`setup \`${spec.setup}\` failed ${when}:\n${tailLines(result.output, 15)}`)
      return false
    }

    if (!(await setup('on the fixture'))) return finish()

    // 1. The fixture as the agent sees it.
    const existingBase = spec.existingTests ? toTestRun(await run(spec.existingTests, commandTimeout)) : undefined
    const hiddenBase = toTestRun(await run(spec.hiddenTests!, commandTimeout))
    if (existingBase) {
      notes.push(describe('fixture, existing tests', existingBase))
      if (!existingBase.passed) {
        problems.push(`the task's own tests fail on the fixture, so a regression cannot be told from a pre-existing failure:\n${tailLines(existingBase.outputTail, 15)}`)
      }
    }
    notes.push(describe('fixture, hidden tests', hiddenBase))
    if (hiddenBase.passed) problems.push('the hidden tests already pass on the fixture, so they do not test the task')

    // 2. The fixture with the reference solution.
    const apply = await gitResult(['apply', '--whitespace=nowarn', task.referencePatchPath], checkout)
    if (apply.code !== 0) {
      problems.push(`reference.patch does not apply to repo/:\n${tailLines(apply.stderr || apply.stdout, 15)}`)
      return finish()
    }
    const touched = await patchNumstat(task.referencePatchPath, checkout)
    if (touched.some(row => row.file.startsWith(`${spec.hiddenDir}/`))) {
      problems.push(`reference.patch touches ${spec.hiddenDir}/, where the hidden tests are copied; they would be overwritten`)
    }
    if (spec.scope.length > 0) {
      const outside = touched.map(row => row.file).filter(file => !matchesAny(spec.scope, file))
      if (outside.length > 0) problems.push(`reference.patch changes files outside grade.scope: ${outside.join(', ')}`)
    }

    if (!(await setup('after the reference patch'))) return finish()

    const hiddenRef = toTestRun(await run(spec.hiddenTests!, commandTimeout))
    notes.push(describe('fixture + reference, hidden tests', hiddenRef))
    if (!hiddenRef.passed) problems.push(`the hidden tests fail with the reference solution applied:\n${tailLines(hiddenRef.outputTail, 25)}`)

    if (spec.existingTests) {
      const existingRef = toTestRun(await run(spec.existingTests, commandTimeout))
      notes.push(describe('fixture + reference, existing tests', existingRef))
      if (!existingRef.passed) problems.push(`the task's own tests fail with the reference solution applied:\n${tailLines(existingRef.outputTail, 15)}`)
    }

    for (const command of spec.checks) {
      const result = await run(command, commandTimeout)
      notes.push(`fixture + reference, \`${command}\`: ${result.exitCode === 0 ? 'ok' : 'FAILED (recorded only; does not decide solved)'}`)
    }
  } catch (error) {
    problems.push(`validation crashed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (!options.keep) fs.rmSync(root, { recursive: true, force: true })
  }
  return finish()
}
