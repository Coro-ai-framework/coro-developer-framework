import fs from 'node:fs'
import path from 'node:path'
import type { Server } from 'node:http'
import { Script, runInNewContext } from 'node:vm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startDashboard } from '../src/dashboard'
import { DASHBOARD_HTML } from '../src/dashboard-page'
import { compareRuns } from '../src/report'
import { resolveScenario } from '../src/scenario'
import { ResultStore, type IndexRecord, type RunInfo } from '../src/store'
import { tmpDir, write } from './helpers/tmp'

describe('eval dashboard', () => {
  const root = path.join(tmpDir(), 'results')
  const store = new ResultStore(root)
  let server: Server
  let url: string

  beforeAll(async () => {
    const runId = '2026-11-14T15-02-32_baseline'
    const info: RunInfo = {
      runId,
      label: 'baseline',
      startedAt: '2026-11-14T13:02:32.318Z',
      finishedAt: '2026-11-14T13:04:24.174Z',
      scenario: resolveScenario(),
      scenarioHash: 'abc123',
      overrides: [],
      coroPath: '/coro',
      coroSha: 'abc',
      coroDirty: false,
      harnessSha: 'def',
      harnessDirty: false,
      tasks: ['ts-slugify'],
    }
    const record: IndexRecord = {
      runId,
      label: 'baseline',
      ts: '2026-11-14T13:04:24.174Z',
      coroSha: 'abc',
      harnessSha: 'def',
      scenarioHash: 'abc123',
      lane: 'standard',
      taskId: 'ts-slugify',
      attempt: 1,
      solved: true,
      outcome: 'complete',
      expectedOutcomeMet: true,
      costUsd: 1.25,
      wallMs: 60_000,
      agentMs: 50_000,
      reviewWaitMs: 0,
      phaseRuns: 4,
      reworkRuns: 0,
      inputTokens: 100,
      outputTokens: 50,
    }

    store.writeRun(info)
    store.appendIndex(record)
    const attemptDir = store.attemptDir(runId, 'ts-slugify', 1)
    write(
      attemptDir,
      'attempt.json',
      JSON.stringify({
        runId,
        taskId: 'ts-slugify',
        attempt: 1,
        outcome: 'complete',
        startedAt: info.startedAt,
        endedAt: info.finishedAt,
        wallMs: 60_000,
      }),
    )
    write(
      attemptDir,
      'grade.json',
      JSON.stringify({
        solved: true,
        reason: 'hidden and existing tests passed',
        delivered: true,
        expectedOutcomeMet: true,
        tests: {
          checkedOut: true,
          setupFailed: false,
          hiddenPassed: true,
          existingPassed: true,
          checksPassed: true,
          checks: [],
          hidden: {
            command: 'pnpm test hidden',
            exitCode: 0,
            timedOut: false,
            durationMs: 10,
            outputTail: '1 passed',
            outputBytes: 8,
            passed: true,
            counts: { passed: 1, failed: 0, total: 1 },
          },
        },
      }),
    )
    write(
      attemptDir,
      'timeline.json',
      JSON.stringify({
        dispatchedAt: info.startedAt,
        endedAt: info.finishedAt,
        entries: [{ at: info.startedAt, elapsedMs: 0, status: 'planning', phase: 'planning' }],
      }),
    )
    write(attemptDir, 'diff.patch', 'diff --git a/src/a.ts b/src/a.ts\n')

    const started = await startDashboard({ resultsDir: root, port: 0 })
    server = started.server
    url = started.url
  })

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('serves the dashboard page', async () => {
    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('<title>Coro eval</title>')
  })

  it('lists runs newest first with their aggregate result', async () => {
    const response = await fetch(`${url}/api/runs`)
    const runs = (await response.json()) as Array<{ runId: string; overall: { solved: number } }>
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      runId: '2026-11-14T15-02-32_baseline',
      overall: { solved: 1 },
    })
  })

  it('returns a run and its attempts', async () => {
    const response = await fetch(`${url}/api/runs/2026-11-14T15-02-32_baseline`)
    const run = (await response.json()) as { info: RunInfo; attempts: IndexRecord[] }
    expect(run.info.label).toBe('baseline')
    expect(run.attempts).toHaveLength(1)
    expect(run.attempts[0]).toMatchObject({ taskId: 'ts-slugify', solved: true })
  })

  it('returns the test result artifacts for an attempt', async () => {
    const response = await fetch(`${url}/api/runs/2026-11-14T15-02-32_baseline/attempts/ts-slugify/1`)
    const attempt = (await response.json()) as {
      grade: { tests: { hidden: { counts: { passed: number } } } }
      diff: string
    }
    expect(attempt.grade.tests.hidden.counts.passed).toBe(1)
    expect(attempt.diff).toContain('diff --git')
  })

  it('exposes detailed metrics and only existing allowlisted artifacts', async () => {
    const dir = store.attemptDir(store.readIndex()[0]!.runId, 'ts-slugify', 1)
    write(dir, 'metrics.json', JSON.stringify({ toolFailures: 2, phases: [{ phase: 'coding', costUsd: 1.25 }] }))
    write(dir, 'private.txt', 'not an artifact')
    const response = await fetch(`${url}/api/runs/2026-11-14T15-02-32_baseline/attempts/ts-slugify/1`)
    const attempt = await response.json() as { metrics: { toolFailures: number }; artifacts: Array<{ name: string; bytes: number }> }
    expect(attempt.metrics.toolFailures).toBe(2)
    expect(attempt.artifacts).toContainEqual({ name: 'diff.patch', bytes: Buffer.byteLength('diff --git a/src/a.ts b/src/a.ts\n') })
    expect(attempt.artifacts.map(item => item.name)).not.toContain('private.txt')
  })

  it('compares shared tasks using the same math as the CLI', async () => {
    const original = store.readIndex()[0]!
    const info = store.readRun(original.runId)
    const runId = '2026-11-14T16-02-32_candidate'
    store.writeRun({ ...info, runId, label: 'candidate', scenarioHash: 'different' })
    const candidate = { ...original, runId, solved: false, costUsd: 2.5 }
    store.appendIndex(candidate)
    store.appendIndex({ ...candidate, taskId: 'candidate-only' })
    const response = await fetch(`${url}/api/compare?a=${original.runId}&b=${runId}`)
    const result = await response.json() as { comparison: ReturnType<typeof compareRuns> }
    expect(result.comparison).toEqual(compareRuns([original], [candidate, { ...candidate, taskId: 'candidate-only' }]))
    expect(result.comparison.overall.metrics[0]).toMatchObject({ delta: -1, verdict: 'unknown' })
    expect((await fetch(`${url}/api/compare?a=missing&b=${runId}`)).status).toBe(404)
  })

  it('bounds log previews but downloads the complete artifact', async () => {
    const dir = store.attemptDir(store.readIndex()[0]!.runId, 'ts-slugify', 1)
    const log = 'start\n' + 'x'.repeat(100_000) + '\nlast failure'
    write(dir, 'runner.log', log)
    const endpoint = `${url}/api/runs/2026-11-14T15-02-32_baseline/attempts/ts-slugify/1/artifacts/runner.log`
    const preview = await (await fetch(endpoint)).json() as { text: string; bytes: number; truncated: boolean }
    expect(preview.truncated).toBe(true)
    expect(preview.bytes).toBe(Buffer.byteLength(log))
    expect(preview.text).toHaveLength(64 * 1024)
    expect(preview.text.endsWith('\nlast failure')).toBe(true)
    const response = await fetch(`${endpoint}?download=1`)
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="runner.log"')
    expect(await response.text()).toBe(log)
    expect((await fetch(endpoint.replace('runner.log', 'private.txt'))).status).toBe(404)
  })

  it('reports malformed artifacts rather than silently hiding diagnostics', async () => {
    const dir = store.attemptDir(store.readIndex()[0]!.runId, 'ts-slugify', 1)
    write(dir, 'metrics.json', '{broken')
    const response = await fetch(`${url}/api/runs/2026-11-14T15-02-32_baseline/attempts/ts-slugify/1`)
    expect(response.status).toBe(500)
    expect(await response.json()).toHaveProperty('error')
    fs.unlinkSync(path.join(dir, 'metrics.json'))
  })

  it('refuses artifact symlinks outside the attempt directory', async () => {
    const dir = store.attemptDir(store.readIndex()[0]!.runId, 'ts-slugify', 1)
    const outside = write(tmpDir(), 'job.log', 'outside log')
    fs.symlinkSync(outside, path.join(dir, 'job.log'))
    const response = await fetch(`${url}/api/runs/2026-11-14T15-02-32_baseline/attempts/ts-slugify/1/artifacts/job.log`)
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('outside log')
  })

  it('does not use unmatched URL segments as file paths', async () => {
    fs.writeFileSync(path.join(root, 'secret.json'), '{"secret":true}')
    const response = await fetch(
      `${url}/api/runs/2026-11-14T15-02-32_baseline/attempts/${encodeURIComponent('../secret')}/1`,
    )
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('"secret":true')
  })

  describe('dashboard client', () => {
    const script = DASHBOARD_HTML.match(/<script>([\s\S]*?)<\/script>/)![1]!

    it('ships syntactically valid inline JavaScript', () => {
      expect(() => new Script(script)).not.toThrow()
    })

    it('combines attempt filters, sorts numerically, and escapes task names', () => {
      const rows = { innerHTML: '', querySelectorAll: () => [] }
      const counter = { textContent: '' }
      const node = { addEventListener: () => {} }
      const context = {
        document: { querySelector: (selector: string) => selector === '#attempt-rows' ? rows : selector === '#attempt-count' ? counter : node },
        addEventListener: () => {},
        setInterval: () => {},
      }
      runInNewContext(script.replace(/\n    boot\(\);/, ''), context)
      runInNewContext(`
        state.run = { attempts: [
          { taskId: '<task>', attempt: 1, solved: false, outcome: 'timeout', costUsd: 2 },
          { taskId: '<task>', attempt: 2, solved: false, outcome: 'timeout', costUsd: 10 },
          { taskId: '<task>', attempt: 3, solved: true, outcome: 'complete', costUsd: 20 },
          { taskId: 'other', attempt: 1, solved: false, outcome: 'timeout', costUsd: 30 }
        ] };
        state.filters = { query: '<task>', result: 'failed', outcome: 'timeout', sort: 'costUsd' };
        renderAttempts();
      `, context)
      expect(counter.textContent).toBe('2 / 4 attempts')
      expect(rows.innerHTML).not.toContain('<task>')
      expect(rows.innerHTML.indexOf('#2')).toBeLessThan(rows.innerHTML.indexOf('#1'))
      expect(rows.innerHTML).not.toContain('#3')
      runInNewContext("state.filters.query = 'missing'; renderAttempts();", context)
      expect(rows.innerHTML).toContain('No matching graded attempts.')
    })
  })

  it('does not trust traversal paths stored in a corrupt index', async () => {
    const original = store.readIndex()[0]!
    store.appendIndex({ ...original, taskId: '../secret', attempt: 2 })
    write(store.runDir(original.runId), 'secret-2/grade.json', '{"reason":"outside result"}')

    const response = await fetch(
      `${url}/api/runs/${original.runId}/attempts/${encodeURIComponent('../secret')}/2`,
    )
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('outside result')
  })

  it('does not follow an attempt directory symlink outside its run', async () => {
    const original = store.readIndex()[0]!
    store.appendIndex({ ...original, taskId: 'linked', attempt: 3 })
    const outside = path.join(tmpDir(), 'outside')
    write(outside, 'grade.json', '{"reason":"symlink secret"}')
    fs.symlinkSync(outside, store.attemptDir(original.runId, 'linked', 3), 'dir')

    const response = await fetch(`${url}/api/runs/${original.runId}/attempts/linked/3`)
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('symlink secret')
  })

  it('refuses to expose the unauthenticated dashboard on a non-loopback host', async () => {
    await expect(startDashboard({ resultsDir: root, host: '0.0.0.0', port: 0 })).rejects.toThrow(/loopback/)
  })
})
