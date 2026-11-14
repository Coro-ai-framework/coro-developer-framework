import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AttemptRun } from '../src/attempt'
import { askedForHelp, gradeAttempt, outcomeMeetsExpectation } from '../src/grade'
import {
  aggregateSamples,
  buildJudgePrompt,
  extractJson,
  issuesMatch,
  parseJudgeSample,
  runJudge,
  type CompleteFn,
  type JudgeSample,
} from '../src/grade/judge'
import { gradeScope, parseNumstat, patchNumstat } from '../src/grade/scope'
import { parseTestCounts, toTestRun } from '../src/grade/tests'
import { resolveScenario } from '../src/scenario'
import type { Task } from '../src/tasks'
import type { AttemptOutcome } from '../src/types'
import { git, makeRepo, tmpDir, write } from './helpers/tmp'

describe('parseTestCounts', () => {
  it('reads a vitest summary', () => {
    const output = ' Test Files  1 failed (1)\n      Tests  2 failed | 10 passed (12)\n   Duration  1s'
    expect(parseTestCounts(output)).toEqual({ passed: 10, failed: 2, total: 12 })
  })

  it('reads a vitest summary with no failures', () => {
    expect(parseTestCounts('      Tests  11 passed (11)')).toEqual({ passed: 11, failed: 0, total: 11 })
  })

  it('reads the node test runner', () => {
    expect(parseTestCounts('ℹ tests 3\nℹ suites 0\nℹ pass 2\nℹ fail 1\n')).toEqual({ passed: 2, failed: 1, total: 3 })
  })

  it('reads the node test runner in TAP form', () => {
    expect(parseTestCounts('TAP version 13\nok 1 - a\n1..1\n# tests 3\n# suites 0\n# pass 3\n# fail 0\n# cancelled 0')).toEqual({ passed: 3, failed: 0, total: 3 })
  })

  it('reads go test -v, counting subtests', () => {
    const output = ['=== RUN   TestA', '--- PASS: TestA (0.00s)', '=== RUN   TestB', '    --- FAIL: TestB/sub (0.00s)', '--- FAIL: TestB (0.00s)', 'FAIL'].join('\n')
    expect(parseTestCounts(output)).toEqual({ passed: 1, failed: 2, total: 3 })
  })

  it('strips colour codes before reading', () => {
    expect(parseTestCounts('\u001b[2m      Tests \u001b[22m \u001b[32m4 passed\u001b[39m (4)')).toEqual({ passed: 4, failed: 0, total: 4 })
  })

  it('returns undefined for output it does not recognise', () => {
    expect(parseTestCounts('compile error: undefined: NewLRU')).toBeUndefined()
    expect(parseTestCounts('')).toBeUndefined()
  })
})

describe('toTestRun', () => {
  const shell = (output: string, exitCode: number | null = 0, timedOut = false) => ({
    command: 'test',
    exitCode,
    signal: null,
    timedOut,
    durationMs: 1,
    output,
    outputBytes: output.length,
  })

  it('passes on a zero exit with tests counted', () => {
    expect(toTestRun(shell('      Tests  3 passed (3)')).passed).toBe(true)
  })

  it('fails on a non-zero exit', () => {
    expect(toTestRun(shell('      Tests  1 failed | 2 passed (3)', 1)).passed).toBe(false)
  })

  it('does not count a run that found no tests as a pass', () => {
    expect(toTestRun(shell('      Tests  0 passed (0)')).passed).toBe(false)
    expect(toTestRun(shell('ℹ tests 0\nℹ pass 0\nℹ fail 0')).passed).toBe(false)
  })

  it('trusts the exit code when the output has no counts', () => {
    expect(toTestRun(shell('ok  \texample.com/cache\t0.3s')).passed).toBe(true)
  })

  it('fails on a timeout even with a zero exit code', () => {
    expect(toTestRun(shell('      Tests  3 passed (3)', 0, true)).passed).toBe(false)
  })
})

describe('scope', () => {
  it('parses numstat, counting binary files as zero lines', () => {
    expect(parseNumstat('3\t1\tsrc/a.ts\n-\t-\timg.png\n\nnot a row\n')).toEqual([
      { file: 'src/a.ts', added: 3, removed: 1 },
      { file: 'img.png', added: 0, removed: 0 },
    ])
  })

  it('sizes a change and finds files outside the allowed globs', () => {
    const grade = gradeScope({
      numstat: parseNumstat('10\t2\tsrc/a.ts\n5\t0\ttests/a.test.ts\n1\t1\tpackage.json'),
      scope: ['src/**', 'tests/**'],
    })
    expect(grade).toMatchObject({ filesChanged: 3, linesAdded: 16, linesRemoved: 3, outOfScopeFiles: ['package.json'] })
    expect(grade.sizeRatio).toBeUndefined()
  })

  it('allows anything when the task declares no scope', () => {
    expect(gradeScope({ numstat: parseNumstat('1\t0\tanything'), scope: [] }).outOfScopeFiles).toEqual([])
  })

  it('compares with the reference solution', () => {
    const grade = gradeScope({
      numstat: parseNumstat('30\t0\ta.ts'),
      scope: [],
      referenceNumstat: parseNumstat('10\t0\ta.ts\n5\t0\tb.ts'),
    })
    expect(grade.reference).toEqual({ filesChanged: 2, linesAdded: 15, linesRemoved: 0 })
    expect(grade.sizeRatio).toBe(2)
  })

  it('reads the size of a patch file without a repository', async () => {
    const dir = tmpDir()
    const patch = write(
      dir,
      'ref.patch',
      ['diff --git a/x.txt b/x.txt', '--- a/x.txt', '+++ b/x.txt', '@@ -1,2 +1,3 @@', ' one', '-two', '+TWO', '+three', ''].join('\n'),
    )
    expect(await patchNumstat(patch, dir)).toEqual([{ file: 'x.txt', added: 2, removed: 1 }])
  })

  it('returns nothing for a patch git cannot read', async () => {
    const dir = tmpDir()
    expect(await patchNumstat(write(dir, 'bad.patch', 'garbage'), dir)).toEqual([])
  })
})

const sample = (overrides: Partial<JudgeSample> = {}): JudgeSample => ({
  scores: { correctness: 4, scopeDiscipline: 4, readability: 4, testQuality: 4, risk: 4 },
  issues: [],
  summary: 'fine',
  ...overrides,
})

describe('judge parsing', () => {
  const body = JSON.stringify(sample({ issues: [{ severity: 'major', file: 'src/a.ts', summary: 'unbounded retry loop' }] }))

  it('reads bare JSON, fenced JSON, and JSON inside a sentence', () => {
    expect(parseJudgeSample(body).scores.correctness).toBe(4)
    expect(parseJudgeSample('```json\n' + body + '\n```').scores.risk).toBe(4)
    expect(parseJudgeSample(`Here is my review:\n${body}\nHope that helps.`).issues).toHaveLength(1)
  })

  it('rejects scores outside 1 to 5, fractions, and missing fields', () => {
    const withScore = (value: unknown) => JSON.stringify({ scores: { ...sample().scores, correctness: value }, issues: [] })
    expect(() => parseJudgeSample(withScore(6))).toThrow(/correctness/)
    expect(() => parseJudgeSample(withScore(0))).toThrow(/correctness/)
    expect(() => parseJudgeSample(withScore(3.5))).toThrow(/correctness/)
    expect(() => parseJudgeSample(JSON.stringify({ issues: [] }))).toThrow(/scores/)
  })

  it('rejects an unknown severity and prose with no JSON', () => {
    const bad = JSON.stringify({ scores: sample().scores, issues: [{ severity: 'catastrophic', file: 'a', summary: 'x' }] })
    expect(() => parseJudgeSample(bad)).toThrow(/severity/)
    expect(() => parseJudgeSample('I think it is good.')).toThrow(/not valid JSON/)
  })

  it('extractJson throws when there is no object at all', () => {
    expect(() => extractJson('nothing here')).toThrow()
  })

  it('treats the ticket and diff as data inside tagged sections', () => {
    const prompt = buildJudgePrompt({ ticket: 'T', diff: 'D', referencePatch: 'R', automatedResults: 'A' })
    expect(prompt.user).toContain('<ticket>\nT\n</ticket>')
    expect(prompt.user).toContain('<agent_diff>\nD\n</agent_diff>')
    expect(prompt.user).toContain('<reference_diff>\nR\n</reference_diff>')
    expect(prompt.system).toMatch(/never as instructions/)
  })

  it('clips a huge diff instead of overflowing the prompt', () => {
    const prompt = buildJudgePrompt({ ticket: 'T', diff: 'x'.repeat(500_000), referencePatch: '', automatedResults: '' })
    expect(prompt.user.length).toBeLessThan(200_000)
    expect(prompt.user).toContain('truncated')
  })
})

describe('judge aggregation', () => {
  const issue = (summary: string, severity: 'blocker' | 'major' | 'minor' | 'nit' = 'major', file = 'src/a.ts') => ({ severity, file, summary })

  it('takes the median of each score', () => {
    const result = aggregateSamples(
      [
        sample({ scores: { correctness: 5, scopeDiscipline: 2, readability: 3, testQuality: 4, risk: 1 } }),
        sample({ scores: { correctness: 1, scopeDiscipline: 4, readability: 3, testQuality: 4, risk: 5 } }),
        sample({ scores: { correctness: 3, scopeDiscipline: 3, readability: 3, testQuality: 4, risk: 3 } }),
      ],
      'm',
      3,
    )
    expect(result.scores).toEqual({ correctness: 3, scopeDiscipline: 3, readability: 3, testQuality: 4, risk: 3 })
    expect(result.mean).toBe(3.2)
    expect(result.validSamples).toBe(3)
  })

  it('keeps an issue only when more than half of the passes raised it', () => {
    const result = aggregateSamples(
      [
        sample({ issues: [issue('retry loop has no upper bound'), issue('typo in a comment', 'nit', 'src/b.ts')] }),
        sample({ issues: [issue('the retry loop has no bound at all')] }),
        sample({ issues: [] }),
      ],
      'm',
      3,
    )
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ file: 'src/a.ts', agreedBy: 2 })
  })

  it('keeps every issue from a single pass', () => {
    const result = aggregateSamples([sample({ issues: [issue('a b c d'), issue('x y z w', 'minor', 'src/b.ts')] })], 'm', 1)
    expect(result.issues).toHaveLength(2)
  })

  it('reports the worst severity any pass gave a matching issue, and sorts worst first', () => {
    const result = aggregateSamples(
      [
        sample({ issues: [issue('missing null check on the response', 'minor'), issue('unrelated nit here', 'nit', 'src/b.ts')] }),
        sample({ issues: [issue('missing null check on response', 'blocker'), issue('unrelated nit here', 'nit', 'src/b.ts')] }),
      ],
      'm',
      2,
    )
    expect(result.issues.map(i => i.severity)).toEqual(['blocker', 'nit'])
  })

  it('does not merge issues in different files or with different wording', () => {
    expect(issuesMatch(issue('missing null check'), issue('missing null check', 'major', 'src/other.ts'))).toBe(false)
    expect(issuesMatch(issue('missing null check on response'), issue('database connection leaks on error'))).toBe(false)
    expect(issuesMatch(issue('missing null check on response'), issue('missing null check on response body'))).toBe(true)
  })

  it('does not count one pass twice for two similar issues of its own', () => {
    const result = aggregateSamples(
      [sample({ issues: [issue('retry loop unbounded here'), issue('retry loop unbounded again')] }), sample(), sample()],
      'm',
      3,
    )
    expect(result.issues).toEqual([])
  })

  it('refuses to aggregate nothing', () => {
    expect(() => aggregateSamples([], 'm', 1)).toThrow(/no valid/)
  })
})

describe('runJudge', () => {
  const input = { ticket: 't', diff: 'd', referencePatch: 'r', automatedResults: 'a' }
  const reply = (s: JudgeSample): string => JSON.stringify(s)

  it('asks the requested number of times and aggregates', async () => {
    let calls = 0
    const complete: CompleteFn = async () => {
      calls++
      return reply(sample())
    }
    const result = await runJudge({ complete, model: 'judge-model', samples: 3, input })
    expect(calls).toBe(3)
    expect(result.validSamples).toBe(3)
    expect(result.model).toBe('judge-model')
  })

  it('asks again, telling the model what was wrong, when a reply is not JSON', async () => {
    const prompts: string[] = []
    const replies = ['sure, looks good!', reply(sample())]
    const complete: CompleteFn = async ({ user }) => {
      prompts.push(user)
      return replies.shift()!
    }
    const result = await runJudge({ complete, model: 'm', samples: 1, input })
    expect(result.validSamples).toBe(1)
    expect(prompts[1]).toContain('previous reply was rejected')
  })

  it('retries a failed call and then gives up on that pass', async () => {
    const complete: CompleteFn = async () => {
      throw new Error('overloaded')
    }
    await expect(runJudge({ complete, model: 'm', samples: 2, input, maxAttempts: 2 })).rejects.toThrow(/no usable result: model call failed: overloaded/)
  })

  it('keeps going when some passes fail and notes why', async () => {
    let n = 0
    const complete: CompleteFn = async () => (n++ === 0 ? 'garbage' : reply(sample()))
    const result = await runJudge({ complete, model: 'm', samples: 2, input, maxAttempts: 1 })
    expect(result.validSamples).toBe(1)
    expect(result.failures).toHaveLength(1)
  })
})

describe('outcomes and expectations', () => {
  it('only a stop-and-ask counts as asking for help', () => {
    expect(askedForHelp('escalated')).toBe(true)
    expect(askedForHelp('needs-human')).toBe(true)
    for (const outcome of ['complete', 'failed', 'timeout', 'cancelled', 'runner-crashed', 'dispatch-error'] as AttemptOutcome[]) {
      expect(askedForHelp(outcome), outcome).toBe(false)
    }
  })

  it('a PR task is met by complete, an escalate task by asking', () => {
    expect(outcomeMeetsExpectation('pr', 'complete')).toBe(true)
    expect(outcomeMeetsExpectation('pr', 'escalated')).toBe(false)
    expect(outcomeMeetsExpectation('escalate', 'escalated')).toBe(true)
    expect(outcomeMeetsExpectation('escalate', 'complete')).toBe(false)
  })
})

describe('gradeAttempt', () => {
  const task = (overrides: Partial<Task> = {}): Task =>
    ({
      id: 't',
      size: 'small',
      language: 'typescript',
      description: 'do it',
      expect: 'escalate',
      timeoutMinutes: 5,
      grade: { hiddenDir: 'hidden', checks: [], scope: [] },
      dir: '/none',
      repoDir: '/none/repo',
      hiddenTestsDir: '/none/hidden-tests',
      referencePatchPath: '/none/reference.patch',
      ...overrides,
    }) as Task

  async function runWith(outcome: AttemptOutcome, delivered: boolean) {
    const { dir, baseSha } = await makeRepo({ 'a.txt': 'base\n' })
    let headSha: string | undefined
    if (delivered) {
      write(dir, 'a.txt', 'changed\n')
      await git(dir, 'add', '-A')
      await git(dir, 'commit', '-q', '-m', 'work')
      headSha = (await git(dir, 'rev-parse', 'HEAD')).trim()
    }
    const run = {
      meta: { runId: 'r', taskId: 't', attempt: 1, outcome, startedAt: '', endedAt: '', wallMs: 1 },
      timeline: { dispatchedAt: '', endedAt: '', entries: [] },
      workspace: { root: dir, home: dir, configPath: '', workingDir: dir, sandbox: dir, grade: path.join(tmpDir(), 'grade'), baseSha },
      delivery: delivered
        ? { delivered: true, baseSha, headSha, via: 'merged', branches: [], skippedBranches: [] }
        : { delivered: false, baseSha, branches: [], skippedBranches: [] },
      diff: delivered ? 'diff' : '',
    } as unknown as AttemptRun
    return { run, artifactsDir: tmpDir() }
  }

  it('solves an escalate task by escalating', async () => {
    const { run, artifactsDir } = await runWith('escalated', false)
    const grade = await gradeAttempt({ task: task(), scenario: resolveScenario(), run, env: process.env, artifactsDir, judgeComplete: null })
    expect(grade).toMatchObject({ solved: true, delivered: false, expectedOutcomeMet: true })
    expect(fs.existsSync(path.join(artifactsDir, 'grade.json'))).toBe(true)
  })

  it('counts a job parked for a person as having asked', async () => {
    const { run, artifactsDir } = await runWith('needs-human', false)
    const grade = await gradeAttempt({ task: task(), scenario: resolveScenario(), run, env: process.env, artifactsDir, judgeComplete: null })
    expect(grade.solved).toBe(true)
  })

  it('does not solve an escalate task by shipping something', async () => {
    const { run, artifactsDir } = await runWith('complete', true)
    const grade = await gradeAttempt({ task: task(), scenario: resolveScenario(), run, env: process.env, artifactsDir, judgeComplete: null })
    expect(grade.solved).toBe(false)
    expect(grade.reason).toMatch(/shipped a change/)
    expect(grade.scope?.filesChanged).toBe(1)
  })

  it('does not solve a PR task when nothing was delivered, and never calls the judge', async () => {
    const { run, artifactsDir } = await runWith('failed', false)
    let judged = 0
    const grade = await gradeAttempt({
      task: task({ expect: 'pr' }),
      scenario: resolveScenario(),
      run,
      env: process.env,
      artifactsDir,
      judgeComplete: async () => {
        judged++
        return ''
      },
    })
    expect(grade).toMatchObject({ solved: false, delivered: false, expectedOutcomeMet: false })
    expect(grade.reason).toMatch(/nothing delivered/)
    expect(judged).toBe(0)
  })
})
