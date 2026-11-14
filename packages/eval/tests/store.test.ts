import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { resolveScenario } from '../src/scenario'
import { formatRunId, ResultStore, type IndexRecord, type RunInfo } from '../src/store'
import { tmpDir } from './helpers/tmp'

const record = (overrides: Partial<IndexRecord> = {}): IndexRecord => ({
  runId: 'r1',
  label: 'l',
  ts: '2024-01-01T00:00:00.000Z',
  coroSha: 'abc',
  harnessSha: 'def',
  scenarioHash: 'h',
  lane: 'standard',
  taskId: 't',
  attempt: 1,
  solved: true,
  outcome: 'complete',
  expectedOutcomeMet: true,
  costUsd: 1,
  wallMs: 1,
  agentMs: 1,
  reviewWaitMs: 0,
  phaseRuns: 1,
  reworkRuns: 0,
  inputTokens: 1,
  outputTokens: 1,
  ...overrides,
})

const info = (runId: string): RunInfo => ({
  runId,
  label: 'l',
  startedAt: '2024-01-01T00:00:00Z',
  scenario: resolveScenario(),
  scenarioHash: 'h',
  overrides: [],
  coroPath: '/coro',
  coroSha: 'abc',
  coroDirty: false,
  harnessSha: 'def',
  harnessDirty: false,
  tasks: ['t'],
})

describe('formatRunId', () => {
  it('is a sortable local timestamp followed by the slugged label', () => {
    const date = new Date(2026, 10, 14, 13, 40, 5)
    expect(formatRunId(date, 'My Label!')).toBe('2026-11-14T13-40-05_my-label')
    expect(formatRunId(date, '')).toBe('2026-11-14T13-40-05')
  })
})

describe('ResultStore', () => {
  it('appends one line per attempt and reads them back in order', () => {
    const store = new ResultStore(path.join(tmpDir(), 'results'))
    expect(store.readIndex()).toEqual([])
    store.appendIndex(record({ attempt: 1 }))
    store.appendIndex(record({ attempt: 2, solved: false }))
    const lines = fs.readFileSync(store.indexPath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(store.readIndex().map(r => r.attempt)).toEqual([1, 2])
  })

  it('never rewrites earlier lines', () => {
    const store = new ResultStore(path.join(tmpDir(), 'results'))
    store.appendIndex(record({ attempt: 1 }))
    const before = fs.readFileSync(store.indexPath, 'utf-8')
    store.appendIndex(record({ attempt: 2 }))
    expect(fs.readFileSync(store.indexPath, 'utf-8').startsWith(before)).toBe(true)
  })

  it('skips a torn line instead of failing', () => {
    const store = new ResultStore(path.join(tmpDir(), 'results'))
    store.appendIndex(record({ attempt: 1 }))
    fs.appendFileSync(store.indexPath, '{"runId":"r1","tas\n')
    store.appendIndex(record({ attempt: 3 }))
    expect(store.readIndex().map(r => r.attempt)).toEqual([1, 3])
  })

  it('filters the index by run', () => {
    const store = new ResultStore(path.join(tmpDir(), 'results'))
    store.appendIndex(record({ runId: 'a' }))
    store.appendIndex(record({ runId: 'b' }))
    store.appendIndex(record({ runId: 'a' }))
    expect(store.readRunRecords('a')).toHaveLength(2)
  })

  it('round-trips run.json and writes summary.json beside it', () => {
    const store = new ResultStore(path.join(tmpDir(), 'results'))
    store.writeRun(info('run-1'))
    store.writeSummary('run-1', { tasks: [] })
    expect(store.readRun('run-1').runId).toBe('run-1')
    expect(JSON.parse(fs.readFileSync(path.join(store.runDir('run-1'), 'summary.json'), 'utf-8'))).toEqual({ tasks: [] })
  })

  it('lays attempts out under the run', () => {
    const store = new ResultStore('/r')
    expect(store.attemptDir('run-1', 'ts-slugify', 2)).toBe('/r/run-1/attempts/ts-slugify-2')
  })

  it('avoids reusing a run id', () => {
    const store = new ResultStore(path.join(tmpDir(), 'results'))
    const date = new Date(2024, 0, 1, 10, 0, 0)
    const first = store.newRunId('x', date)
    store.writeRun(info(first))
    const second = store.newRunId('x', date)
    expect(second).not.toBe(first)
    expect(second).toBe(`${first}-2`)
  })

  describe('resolveRunId', () => {
    let store: ResultStore
    beforeEach(() => {
      store = new ResultStore(path.join(tmpDir(), 'results'))
      for (const id of ['2024-01-01T10-00-00_baseline', '2024-01-02T10-00-00_fast', '2024-01-03T10-00-00_fast-lenses-off']) {
        store.writeRun(info(id))
      }
    })

    it('lists runs oldest first', () => {
      expect(store.listRunIds()[0]).toBe('2024-01-01T10-00-00_baseline')
    })

    it('resolves "latest"', () => {
      expect(store.resolveRunId('latest')).toBe('2024-01-03T10-00-00_fast-lenses-off')
    })

    it('resolves an exact id and a unique fragment', () => {
      expect(store.resolveRunId('2024-01-02T10-00-00_fast')).toBe('2024-01-02T10-00-00_fast')
      expect(store.resolveRunId('baseline')).toBe('2024-01-01T10-00-00_baseline')
      expect(store.resolveRunId('lenses-off')).toBe('2024-01-03T10-00-00_fast-lenses-off')
    })

    it('prefers an exact match over a longer id containing it', () => {
      expect(store.resolveRunId('2024-01-02T10-00-00_fast')).toBe('2024-01-02T10-00-00_fast')
    })

    it('refuses an ambiguous fragment and lists the candidates', () => {
      expect(() => store.resolveRunId('fast')).toThrow(/matches 2 runs[\s\S]*_fast-lenses-off/)
    })

    it('refuses an unknown one', () => {
      expect(() => store.resolveRunId('nope')).toThrow(/No run matches "nope"/)
    })

    it('says so when there are no runs at all', () => {
      expect(() => new ResultStore(path.join(tmpDir(), 'empty')).resolveRunId('latest')).toThrow(/No runs found/)
    })
  })

  it('ignores directories that are not runs', () => {
    const root = path.join(tmpDir(), 'results')
    fs.mkdirSync(path.join(root, 'scratch'), { recursive: true })
    const store = new ResultStore(root)
    store.writeRun(info('real'))
    expect(store.listRunIds()).toEqual(['real'])
  })
})
