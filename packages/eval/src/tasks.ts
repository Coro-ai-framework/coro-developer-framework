import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { z } from 'zod'
import { globMatch } from './glob'
import { PACKAGE_ROOT } from './util'

export const TASKS_DIR = path.join(PACKAGE_ROOT, 'tasks')

export const SIZES = ['small', 'medium', 'large'] as const

const gradeSchema = z
  .object({
    /** Run once in the graded checkout before anything else, e.g. `npm ci`. */
    setup: z.string().min(1).optional(),
    /** Run against the hidden tests; they are copied in only after the job ends. */
    hiddenTests: z.string().min(1).optional(),
    /** Directory (relative to the checkout) the hidden tests are copied into. */
    hiddenDir: z.string().min(1).default('hidden'),
    /** The task's own tests, which must keep passing. */
    existingTests: z.string().min(1).optional(),
    /** Lint, typecheck, static analysis: recorded, not part of "solved". */
    checks: z.array(z.string().min(1)).default([]),
    /** Globs a change may touch; anything else counts as scope creep. Empty means no limit. */
    scope: z.array(z.string().min(1)).default([]),
  })
  .strict()

export const taskSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and hyphens only'),
    size: z.enum(SIZES),
    language: z.string().min(1),
    /** The only thing Coro sees. */
    description: z.string().min(1),
    /** `pr`: the job should deliver a change. `escalate`: it should stop and ask. */
    expect: z.enum(['pr', 'escalate']).default('pr'),
    timeoutMinutes: z.number().positive().default(60),
    grade: gradeSchema.prefault({}),
  })
  .strict()
  .superRefine((task, ctx) => {
    if (task.expect === 'pr' && !task.grade.hiddenTests) {
      ctx.addIssue({
        code: 'custom',
        path: ['grade', 'hiddenTests'],
        message: 'a task that expects a PR needs grade.hiddenTests',
      })
    }
  })

export type TaskSpec = z.infer<typeof taskSchema>

export interface Task extends TaskSpec {
  /** Absolute directory holding task.yaml. */
  dir: string
  /** Fixture source, committed as the sandbox base. */
  repoDir: string
  /** Hidden tests, copied in only at grading time (absent for `escalate` tasks). */
  hiddenTestsDir: string
  /** A human-written solution (absent for `escalate` tasks). */
  referencePatchPath: string
}

export function loadTask(dir: string): Task {
  const specPath = path.join(dir, 'task.yaml')
  if (!fs.existsSync(specPath)) throw new Error(`No task.yaml in ${dir}`)
  const raw = yaml.load(fs.readFileSync(specPath, 'utf-8'))
  const parsed = taskSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`Invalid ${specPath}:\n${issues}`)
  }
  const spec = parsed.data
  if (spec.id !== path.basename(dir)) {
    throw new Error(`${specPath}: id "${spec.id}" must match its directory name "${path.basename(dir)}"`)
  }
  const task: Task = {
    ...spec,
    dir,
    repoDir: path.join(dir, 'repo'),
    hiddenTestsDir: path.join(dir, 'hidden-tests'),
    referencePatchPath: path.join(dir, 'reference.patch'),
  }
  if (!fs.existsSync(task.repoDir)) throw new Error(`${specPath}: missing repo/ directory`)
  if (spec.expect === 'pr') {
    if (!fs.existsSync(task.hiddenTestsDir)) throw new Error(`${specPath}: missing hidden-tests/ directory`)
    if (!fs.existsSync(task.referencePatchPath)) throw new Error(`${specPath}: missing reference.patch`)
  }
  return task
}

export function loadTasks(tasksDir: string = TASKS_DIR): Task[] {
  if (!fs.existsSync(tasksDir)) return []
  return fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(tasksDir, entry.name, 'task.yaml')))
    .map(entry => loadTask(path.join(tasksDir, entry.name)))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Pick tasks by comma-separated selectors. A selector is a glob matched against
 * the task id, `<size>/<id>` or `<language>/<id>`, so `ts-*`, `small/*` and
 * `go/*` all work. Omitted or `all` selects everything.
 */
export function selectTasks(tasks: readonly Task[], selectors?: string): Task[] {
  const patterns = (selectors ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  if (patterns.length === 0 || patterns.includes('all') || patterns.includes('*')) return [...tasks]

  const selected = new Map<string, Task>()
  for (const pattern of patterns) {
    const matches = tasks.filter(
      task =>
        globMatch(pattern, task.id) ||
        globMatch(pattern, `${task.size}/${task.id}`) ||
        globMatch(pattern, `${task.language}/${task.id}`),
    )
    if (matches.length === 0) {
      throw new Error(
        `Task selector "${pattern}" matched nothing (available: ${tasks.map(t => t.id).join(', ') || 'none'})`,
      )
    }
    for (const task of matches) selected.set(task.id, task)
  }
  return tasks.filter(task => selected.has(task.id))
}
