import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { beforeAll, describe, expect, it } from 'vitest'
import type { CompleteFn } from '../src/grade/judge'
import { renderReport, summarize } from '../src/report'
import { executeRun, planAttempts, type RunResult } from '../src/run'
import { resolveScenario } from '../src/scenario'
import { ResultStore, type IndexRecord } from '../src/store'
import { loadTask, type Task } from '../src/tasks'
import { tmpDir } from './helpers/tmp'

/**
 * The whole harness against a fake `coro start` (tests/fixtures/fake-coro): real
 * processes, real HTTP, real git repositories, real grading commands. Only the
 * runner and the model are stand-ins, so nothing here touches the network.
 */

const FAKE_CORO = path.join(__dirname, 'fixtures', 'fake-coro')
const MINI = path.join(__dirname, 'fixtures', 'tasks', 'mini-task')

interface Variant {
  id: string
  mode: string
  expect?: 'pr' | 'escalate'
  timeoutMinutes?: number
}

/** A copy of the mini task whose ticket carries `[fake:<mode>]`, which tells the fake runner what to do. */
function makeTask(tasksDir: string, { id, mode, expect = 'pr', timeoutMinutes = 5 }: Variant): Task {
  const dir = path.join(tasksDir, id)
  fs.cpSync(MINI, dir, { recursive: true })
  const spec = yaml.load(fs.readFileSync(path.join(dir, 'task.yaml'), 'utf-8')) as Record<string, unknown>
  spec['id'] = id
  spec['expect'] = expect
  spec['timeoutMinutes'] = timeoutMinutes
  spec['description'] = `Fix \`add\` in src/math.js so it returns the sum. [fake:${mode}]`
  fs.writeFileSync(path.join(dir, 'task.yaml'), yaml.dump(spec))
  return loadTask(dir)
}

interface Harness {
  root: string
  store: ResultStore
  result: RunResult
  attemptDir: (taskId: string, attempt?: number) => string
  record: (taskId: string, attempt?: number) => IndexRecord
}

async function runFake(
  variants: Variant[],
  options: {
    overrides?: string[]
    judgeComplete?: CompleteFn | null
    keepWork?: boolean
    signal?: AbortSignal
  } = {},
): Promise<Harness> {
  const root = tmpDir('coro-eval-e2e-')
  const tasks = variants.map(variant => makeTask(path.join(root, 'tasks'), variant))
  const store = new ResultStore(path.join(root, 'results'))
  const scenario = resolveScenario({
    overrides: [
      `coroPath=${FAKE_CORO}`,
      'repeat=1',
      `parallel=${Math.max(1, variants.length)}`,
      'pollIntervalSeconds=0.1',
      'startupTimeoutSeconds=30',
      ...(options.overrides ?? []),
    ],
  })
  const result = await executeRun({
    scenario,
    label: 'e2e',
    tasks,
    store,
    workRoot: path.join(root, 'work'),
    cacheDir: path.join(root, 'cache'),
    keepWork: options.keepWork === true,
    // The environment the harness was "started" with: it carries things that must not reach the run.
    env: {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      CORO_CODING_MODEL: 'leaked-model',
      CLAUDECODE: '1',
      INIT_CWD: '/somewhere',
      npm_lifecycle_event: 'eval',
    },
    credentials: { method: 'apiKey', secret: 'sk-e2e-secret' },
    judgeComplete: options.judgeComplete ?? null,
    needsHumanGraceMs: 300,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return {
    root,
    store,
    result,
    attemptDir: (taskId, attempt = 1) => store.attemptDir(result.runId, taskId, attempt),
    record: (taskId, attempt = 1) => {
      const found = result.records.find(r => r.taskId === taskId && r.attempt === attempt)
      if (!found) throw new Error(`no record for ${taskId}-${attempt}`)
      return found
    },
  }
}

const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf-8'))

describe('planAttempts', () => {
  it('runs attempt 1 of every task before attempt 2 of any, so a stopped run is still balanced', () => {
    const task = (id: string) => ({ id }) as Task
    expect(planAttempts([task('a'), task('b')], 2).map(p => `${p.task.id}-${p.attempt}`)).toEqual(['a-1', 'b-1', 'a-2', 'b-2'])
  })
})

describe('a run against a fake Coro', () => {
  let h: Harness

  beforeAll(async () => {
    h = await runFake([
      { id: 'solve', mode: 'solve' },
      { id: 'wrong', mode: 'wrong' },
      { id: 'fail', mode: 'fail' },
      { id: 'escalate', mode: 'escalate', expect: 'escalate' },
      { id: 'park-pr', mode: 'park' },
      { id: 'park-ask', mode: 'park', expect: 'escalate' },
      { id: 'hang', mode: 'hang', timeoutMinutes: 0.02 },
      { id: 'crash', mode: 'crash' },
    ])
  }, 120_000)

  it('records one attempt per task, in the index and on disk', () => {
    expect(h.result.records).toHaveLength(8)
    expect(h.store.readRunRecords(h.result.runId)).toHaveLength(8)
    expect(h.store.readRun(h.result.runId).finishedAt).toBeTruthy()
    expect(fs.existsSync(path.join(h.store.runDir(h.result.runId), 'summary.json'))).toBe(true)
  })

  describe('a job that opens a good PR and is merged', () => {
    it('is solved', () => {
      expect(h.record('solve')).toMatchObject({ solved: true, outcome: 'complete', expectedOutcomeMet: true })
    })

    it('is graded by running the hidden tests on what was delivered', () => {
      const grade = readJson(path.join(h.attemptDir('solve'), 'grade.json'))
      expect(grade).toMatchObject({ solved: true, delivered: true, reason: 'hidden and existing tests passed' })
      expect(grade.tests.hidden.counts).toEqual({ passed: 2, failed: 0, total: 2 })
      expect(grade.tests.existing.passed).toBe(true)
      expect(grade.scope.outOfScopeFiles).toEqual([])
      expect(grade.judgeSkipped).toMatch(/no judge available/)
    })

    it('delivers through the simulated reviewer: approved while parked, then merged into main', () => {
      const timeline = readJson(path.join(h.attemptDir('solve'), 'timeline.json'))
      const events: string[] = timeline.entries.flatMap((e: { event?: string }) => (e.event ? [e.event] : []))
      expect(events.some(e => e === 'reviewer: approved PR 1')).toBe(true)
      expect(timeline.entries.some((e: { status: string }) => e.status === 'awaiting-pr-merge')).toBe(true)
      const attempt = readJson(path.join(h.attemptDir('solve'), 'attempt.json'))
      expect(attempt.delivery).toMatchObject({ delivered: true, via: 'merged' })
      expect(fs.readFileSync(path.join(h.attemptDir('solve'), 'diff.patch'), 'utf-8')).toContain('+exports.add = (a, b) => a + b')
    })

    it('keeps the raw job, the log, the runner log and the metrics', () => {
      const dir = h.attemptDir('solve')
      for (const file of ['job.json', 'job.log', 'runner.log', 'metrics.json', 'attempt.json', 'timeline.json', 'diff.patch', 'grade.log']) {
        expect(fs.existsSync(path.join(dir, file)), file).toBe(true)
      }
      expect(fs.readFileSync(path.join(dir, 'job.log'), 'utf-8')).toContain('status complete')
      expect(readJson(path.join(dir, 'job.json')).status).toBe('complete')
    })

    it('measures cost, tokens, phases and review wait from the job record', () => {
      const metrics = readJson(path.join(h.attemptDir('solve'), 'metrics.json'))
      expect(metrics).toMatchObject({ costUsd: 1.5, phaseRuns: 3, workItemCount: 1, prCount: 1, outcome: 'complete', outputTokens: 600 })
      expect(h.record('solve')).toMatchObject({ costUsd: 1.5, phaseRuns: 3 })
      expect(metrics.agentMs).toBe(1000 + 3000 + 500)
      expect(metrics.reviewWaitMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('isolation', () => {
    const job = () => readJson(path.join(h.attemptDir('solve'), 'job.json'))

    it('runs the runner with its own HOME, never the real one', () => {
      const home: string = job().params.home
      expect(home).not.toBe(process.env['HOME'])
      expect(home.startsWith(path.join(h.root, 'work'))).toBe(true)
      expect(home.endsWith(`${path.sep}home`)).toBe(true)
    })

    it('hands the runner the harness credentials through its config file', () => {
      expect(job().params.apiKeyLength).toBe('sk-e2e-secret'.length)
    })

    it('does not let the harness environment leak into the run', () => {
      expect(job().params.envLeaks).toEqual([])
    })

    it('gives each attempt its own port', () => {
      const ports = h.result.records.map(r => readJson(path.join(h.attemptDir(r.taskId, r.attempt), 'attempt.json')).port)
      expect(new Set(ports).size).toBe(ports.length)
    })

    it('removes the scratch directories afterwards', () => {
      expect(fs.existsSync(path.join(h.root, 'work', h.result.runId, 'solve-1'))).toBe(false)
    })

    it('never writes the credential into the results', () => {
      const all = fs.readdirSync(h.store.runDir(h.result.runId), { recursive: true, encoding: 'utf-8' })
      for (const relative of all) {
        const file = path.join(h.store.runDir(h.result.runId), relative)
        if (!fs.statSync(file).isFile()) continue
        expect(fs.readFileSync(file, 'utf-8'), relative).not.toContain('sk-e2e-secret')
      }
      expect(fs.readFileSync(h.store.indexPath, 'utf-8')).not.toContain('sk-e2e-secret')
    })
  })

  it('does not solve a task whose delivered code fails the hidden tests', () => {
    expect(h.record('wrong')).toMatchObject({ solved: false, outcome: 'complete' })
    const grade = readJson(path.join(h.attemptDir('wrong'), 'grade.json'))
    expect(grade).toMatchObject({ solved: false, delivered: true, reason: 'hidden tests failed' })
    expect(grade.tests.existing.passed).toBe(true)
    expect(grade.scope.filesChanged).toBe(1)
  })

  it('records a job that fails as failed, with nothing delivered', () => {
    expect(h.record('fail')).toMatchObject({ solved: false, outcome: 'failed' })
    expect(readJson(path.join(h.attemptDir('fail'), 'attempt.json')).delivery.delivered).toBe(false)
    expect(readJson(path.join(h.attemptDir('fail'), 'grade.json')).reason).toMatch(/nothing delivered \(outcome: failed\)/)
  })

  it('solves an escalate task by escalating', () => {
    expect(h.record('escalate')).toMatchObject({ solved: true, outcome: 'escalated', expectedOutcomeMet: true })
  })

  it('calls a job parked for a person needs-human: wrong for a PR task, right for an escalate task', () => {
    expect(h.record('park-pr')).toMatchObject({ solved: false, outcome: 'needs-human', expectedOutcomeMet: false })
    expect(h.record('park-ask')).toMatchObject({ solved: true, outcome: 'needs-human', expectedOutcomeMet: true })
  })

  it('cancels a job that outruns its timeout', () => {
    expect(h.record('hang')).toMatchObject({ solved: false, outcome: 'timeout' })
    expect(readJson(path.join(h.attemptDir('hang'), 'job.json')).status).toBe('cancelled')
  })

  it('records a runner that dies mid-job', () => {
    expect(h.record('crash')).toMatchObject({ solved: false, outcome: 'runner-crashed' })
  })

  it('summarises into per-task rows and a total', () => {
    const summary = summarize(h.store.readRunRecords(h.result.runId))
    expect(summary.overall).toMatchObject({ tasks: 8, attempts: 8, solved: 3 })
    expect(summary.overall.outcomes).toMatchObject({ complete: 2, failed: 1, escalated: 1, 'needs-human': 2, timeout: 1, 'runner-crashed': 1 })
    const text = renderReport(h.store.readRun(h.result.runId), summary)
    expect(text).toContain('solve')
    expect(text).toContain('3/8 attempts')
  })
})

describe('scenario settings reach the runner', () => {
  it('writes model choices and the lens switch into the runner config', async () => {
    const h = await runFake([{ id: 'solve', mode: 'solve' }], { overrides: ['models.coding=claude-sonnet-5-5', 'codeReviewLenses=false'] })
    const params = readJson(path.join(h.attemptDir('solve'), 'job.json')).params
    expect(params.aliases.coding).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' })
    expect(params.aliases['tier:coding']).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' })
    expect(params.lenses).toBe(false)
    expect(h.store.readRun(h.result.runId).scenario.models).toEqual({ coding: 'claude-sonnet-5-5' })
  }, 60_000)

  it('dispatches the workflow for the chosen lane', async () => {
    const h = await runFake([{ id: 'solve', mode: 'solve' }], { overrides: ['lane=fast'] })
    expect(readJson(path.join(h.attemptDir('solve'), 'job.json')).workflowPath).toBe('.claude/commands/coro/job-fast.md')
    expect(h.record('solve').lane).toBe('fast')
  }, 60_000)
})

describe('repeats and parallel attempts', () => {
  it('runs every attempt in isolation and numbers them', async () => {
    const h = await runFake([{ id: 'solve-a', mode: 'solve' }, { id: 'solve-b', mode: 'solve' }], { overrides: ['repeat=2', 'parallel=3'] })
    expect(h.result.records.map(r => `${r.taskId}-${r.attempt}`).sort()).toEqual(['solve-a-1', 'solve-a-2', 'solve-b-1', 'solve-b-2'])
    expect(h.result.records.every(r => r.solved)).toBe(true)
    const homes = h.result.records.map(r => readJson(path.join(h.attemptDir(r.taskId, r.attempt), 'job.json')).params.home)
    expect(new Set(homes).size).toBe(4)
    const summary = summarize(h.result.records)
    expect(summary.tasks.every(t => t.passPowK)).toBe(true)
  }, 120_000)
})

describe('the judge', () => {
  const verdict = JSON.stringify({
    scores: { correctness: 5, scopeDiscipline: 4, readability: 4, testQuality: 3, risk: 4 },
    issues: [{ severity: 'minor', file: 'src/math.js', summary: 'no tests were added for add' }],
    summary: 'Correct and small.',
  })

  it('scores solved work and records the scores with the attempt', async () => {
    const prompts: string[] = []
    const h = await runFake([{ id: 'solve', mode: 'solve' }], {
      judgeComplete: async ({ user }) => {
        prompts.push(user)
        return verdict
      },
    })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('<agent_diff>')
    expect(prompts[0]).toContain('a + b')
    expect(prompts[0]).toContain('Hidden tests: PASSED')
    expect(h.record('solve').judge).toMatchObject({ correctness: 5, testQuality: 3, mean: 4 })
    const judge = readJson(path.join(h.attemptDir('solve'), 'judge.json'))
    expect(judge.issues).toHaveLength(1)
  }, 60_000)

  it('is not called at all when the scenario turns it off', async () => {
    let calls = 0
    const h = await runFake([{ id: 'solve', mode: 'solve' }], {
      overrides: ['judge.enabled=false'],
      judgeComplete: async () => {
        calls++
        return verdict
      },
    })
    expect(calls).toBe(0)
    expect(h.record('solve').judge).toBeUndefined()
    expect(readJson(path.join(h.attemptDir('solve'), 'grade.json')).judgeSkipped).toMatch(/judge disabled/)
  }, 60_000)

  it('never changes whether a task is solved', async () => {
    const h = await runFake([{ id: 'wrong', mode: 'wrong' }], { judgeComplete: async () => verdict })
    expect(h.record('wrong').solved).toBe(false)
  }, 60_000)

  it('is a recorded skip, not a failed attempt, when the judge breaks', async () => {
    const h = await runFake([{ id: 'solve', mode: 'solve' }], {
      judgeComplete: async () => {
        throw new Error('rate limited')
      },
    })
    expect(h.record('solve').solved).toBe(true)
    expect(h.record('solve').judge).toBeUndefined()
    expect(readJson(path.join(h.attemptDir('solve'), 'grade.json')).judgeSkipped).toMatch(/judge failed/)
  }, 60_000)
})

describe('housekeeping', () => {
  it('leaves the config redacted when scratch directories are kept', async () => {
    const h = await runFake([{ id: 'solve', mode: 'solve' }], { keepWork: true })
    const config = path.join(h.root, 'work', h.result.runId, 'solve-1', 'home', '.coro', 'config.json')
    const text = fs.readFileSync(config, 'utf-8')
    expect(text).not.toContain('sk-e2e-secret')
    expect(text).toContain('<redacted>')
  }, 60_000)

  it('starts no attempt once it has been told to stop', async () => {
    const controller = new AbortController()
    controller.abort()
    const h = await runFake([{ id: 'solve', mode: 'solve' }], { signal: controller.signal })
    expect(h.result.records).toEqual([])
    expect(h.store.readIndex()).toEqual([])
  }, 30_000)

  it('records an attempt even when the runner is not built', async () => {
    const root = tmpDir('coro-eval-e2e-')
    const store = new ResultStore(path.join(root, 'results'))
    const task = makeTask(path.join(root, 'tasks'), { id: 'solve', mode: 'solve' })
    const result = await executeRun({
      scenario: resolveScenario({ overrides: [`coroPath=${path.join(root, 'no-such-coro')}`, 'repeat=1'] }),
      label: 'unbuilt',
      tasks: [task],
      store,
      workRoot: path.join(root, 'work'),
      cacheDir: path.join(root, 'cache'),
      env: { PATH: process.env['PATH'] },
      credentials: { method: 'apiKey', secret: 'sk' },
      judgeComplete: null,
    })
    expect(result.records[0]).toMatchObject({ solved: false, outcome: 'dispatch-error' })
    const attempt = readJson(store.attemptDir(result.runId, 'solve', 1) + '/attempt.json')
    expect(attempt.error).toMatch(/Coro is not built/)
  }, 60_000)
})
