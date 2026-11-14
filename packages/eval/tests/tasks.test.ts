import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { globMatch, globToRegExp, matchesAny } from '../src/glob'
import { loadTask, loadTasks, selectTasks, TASKS_DIR, type Task } from '../src/tasks'
import { tmpDir, write } from './helpers/tmp'

function makeTaskDir(root: string, id: string, yaml: string, options: { hidden?: boolean; patch?: boolean } = {}): string {
  const dir = path.join(root, id)
  write(dir, 'task.yaml', yaml)
  write(dir, 'repo/README.md', '# repo\n')
  if (options.hidden !== false) write(dir, 'hidden-tests/a.test.ts', '// hidden\n')
  if (options.patch !== false) write(dir, 'reference.patch', '')
  return dir
}

const MINIMAL = (id: string, extra = '') => `id: ${id}
size: small
language: typescript
description: do the thing
grade:
  hiddenTests: npx vitest run hidden/
${extra}`

describe('loadTask', () => {
  it('applies defaults', () => {
    const root = tmpDir()
    const task = loadTask(makeTaskDir(root, 'a-task', MINIMAL('a-task')))
    expect(task.expect).toBe('pr')
    expect(task.timeoutMinutes).toBe(60)
    expect(task.grade.hiddenDir).toBe('hidden')
    expect(task.grade.checks).toEqual([])
    expect(task.grade.scope).toEqual([])
    expect(task.repoDir).toBe(path.join(root, 'a-task', 'repo'))
  })

  it('requires the id to match the directory', () => {
    const root = tmpDir()
    expect(() => loadTask(makeTaskDir(root, 'dir-name', MINIMAL('other-name')))).toThrow(/must match its directory/)
  })

  it('requires hidden tests for a task that expects a PR', () => {
    const root = tmpDir()
    const yaml = `id: no-hidden\nsize: small\nlanguage: go\ndescription: x\n`
    expect(() => loadTask(makeTaskDir(root, 'no-hidden', yaml))).toThrow(/hiddenTests/)
  })

  it('requires the hidden-tests directory and a reference patch for a PR task', () => {
    const root = tmpDir()
    expect(() => loadTask(makeTaskDir(root, 'a', MINIMAL('a'), { hidden: false }))).toThrow(/hidden-tests/)
    expect(() => loadTask(makeTaskDir(root, 'b', MINIMAL('b'), { patch: false }))).toThrow(/reference\.patch/)
  })

  it('needs neither for a task that expects an escalation', () => {
    const root = tmpDir()
    const yaml = `id: ask\nsize: small\nlanguage: typescript\nexpect: escalate\ndescription: vague\n`
    const task = loadTask(makeTaskDir(root, 'ask', yaml, { hidden: false, patch: false }))
    expect(task.expect).toBe('escalate')
  })

  it('rejects unknown keys and bad ids', () => {
    const root = tmpDir()
    expect(() => loadTask(makeTaskDir(root, 'typo', MINIMAL('typo', 'extra: 1\n')))).toThrow(/Invalid/)
    expect(() => loadTask(makeTaskDir(root, 'Bad_Id', MINIMAL('Bad_Id')))).toThrow(/lowercase/)
  })

  it('needs a repo directory', () => {
    const root = tmpDir()
    const dir = makeTaskDir(root, 'norepo', MINIMAL('norepo'))
    fs.rmSync(path.join(dir, 'repo'), { recursive: true })
    expect(() => loadTask(dir)).toThrow(/repo\//)
  })
})

describe('selectTasks', () => {
  const task = (id: string, size: Task['size'], language: string): Task =>
    ({ id, size, language, expect: 'pr', dir: '', repoDir: '', hiddenTestsDir: '', referencePatchPath: '' }) as unknown as Task
  const tasks = [task('ts-a', 'small', 'typescript'), task('ts-b', 'large', 'typescript'), task('go-c', 'medium', 'go')]

  it('selects everything by default', () => {
    expect(selectTasks(tasks)).toHaveLength(3)
    expect(selectTasks(tasks, '')).toHaveLength(3)
    expect(selectTasks(tasks, 'all')).toHaveLength(3)
  })

  it('selects by id, glob, size and language', () => {
    expect(selectTasks(tasks, 'ts-a').map(t => t.id)).toEqual(['ts-a'])
    expect(selectTasks(tasks, 'ts-*').map(t => t.id)).toEqual(['ts-a', 'ts-b'])
    expect(selectTasks(tasks, 'small/*').map(t => t.id)).toEqual(['ts-a'])
    expect(selectTasks(tasks, 'go/*').map(t => t.id)).toEqual(['go-c'])
    expect(selectTasks(tasks, 'large/ts-b').map(t => t.id)).toEqual(['ts-b'])
  })

  it('unions several selectors without duplicates, in the original order', () => {
    expect(selectTasks(tasks, 'go-c, ts-*, ts-a').map(t => t.id)).toEqual(['ts-a', 'ts-b', 'go-c'])
  })

  it('fails when a selector matches nothing, naming what exists', () => {
    expect(() => selectTasks(tasks, 'nope')).toThrow(/matched nothing[\s\S]*ts-a/)
  })
})

describe('glob', () => {
  it('matches within a path segment with * and across segments with **', () => {
    expect(globMatch('src/*.ts', 'src/a.ts')).toBe(true)
    expect(globMatch('src/*.ts', 'src/deep/a.ts')).toBe(false)
    expect(globMatch('src/**', 'src/deep/a.ts')).toBe(true)
    expect(globMatch('src/**', 'src/a.ts')).toBe(true)
    expect(globMatch('**/*.ts', 'a/b/c.ts')).toBe(true)
    expect(globMatch('**/*.ts', 'c.ts')).toBe(true)
    expect(globMatch('*.go', 'lru.go')).toBe(true)
    expect(globMatch('*.go', 'sub/lru.go')).toBe(false)
  })

  it('matches ? as one non-separator character', () => {
    expect(globMatch('a?c', 'abc')).toBe(true)
    expect(globMatch('a?c', 'a/c')).toBe(false)
    expect(globMatch('a?c', 'ac')).toBe(false)
  })

  it('escapes regular-expression characters', () => {
    expect(globMatch('a.b', 'a.b')).toBe(true)
    expect(globMatch('a.b', 'axb')).toBe(false)
    expect(globMatch('(x)+[y]', '(x)+[y]')).toBe(true)
    expect(globToRegExp('a.b').source).toContain('\\.')
  })

  it('matchesAny is true when any glob matches', () => {
    expect(matchesAny(['src/**', 'tests/**'], 'tests/a.test.ts')).toBe(true)
    expect(matchesAny(['src/**'], 'README.md')).toBe(false)
    expect(matchesAny([], 'anything')).toBe(false)
  })
})

describe('the shipped tasks', () => {
  const tasks = loadTasks(TASKS_DIR)

  it('are all valid', () => {
    expect(tasks.length).toBeGreaterThanOrEqual(6)
  })

  it('cover the three sizes, a second language, and a should-escalate case', () => {
    expect(new Set(tasks.map(t => t.size))).toEqual(new Set(['small', 'medium', 'large']))
    expect(tasks.some(t => t.language === 'go')).toBe(true)
    expect(tasks.some(t => t.expect === 'escalate')).toBe(true)
  })

  it('each have a ticket, a fixture, and (for PR tasks) hidden tests and a reference patch', () => {
    for (const task of tasks) {
      expect(task.description.trim().length, task.id).toBeGreaterThan(20)
      expect(fs.existsSync(path.join(task.repoDir, 'README.md')), `${task.id} fixture`).toBe(true)
      if (task.expect === 'pr') {
        expect(fs.readdirSync(task.hiddenTestsDir).length, `${task.id} hidden tests`).toBeGreaterThan(0)
        expect(fs.statSync(task.referencePatchPath).size, `${task.id} reference patch`).toBeGreaterThan(0)
      }
    }
  })

  it('never ship dependencies or build output inside a fixture', () => {
    for (const task of tasks) {
      expect(fs.existsSync(path.join(task.repoDir, 'node_modules')), task.id).toBe(false)
      expect(fs.existsSync(path.join(task.repoDir, '.git')), task.id).toBe(false)
    }
  })

  it('pin npm dependencies with a lockfile so `npm ci` works', () => {
    for (const task of tasks.filter(t => t.grade.setup?.includes('npm ci'))) {
      expect(fs.existsSync(path.join(task.repoDir, 'package-lock.json')), task.id).toBe(true)
    }
  })

  it('keep the hidden tests out of the fixture the agent sees', () => {
    for (const task of tasks.filter(t => t.expect === 'pr')) {
      expect(fs.existsSync(path.join(task.repoDir, task.grade.hiddenDir)), `${task.id}/${task.grade.hiddenDir}`).toBe(false)
    }
  })
})
