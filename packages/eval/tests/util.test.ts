import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { reservePort } from '../src/runner-process'
import {
  expandHome,
  mapPool,
  mean,
  median,
  resolvePath,
  round,
  runShell,
  shortHash,
  slugify,
  stableStringify,
  stdev,
  sum,
  tailLines,
} from '../src/util'

describe('numbers', () => {
  it('computes mean, median and sample standard deviation', () => {
    expect(sum([1, 2, 3])).toBe(6)
    expect(mean([1, 2, 3, 4])).toBe(2.5)
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(stdev([1, 2, 3])).toBe(1)
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3)
  })

  it('returns undefined rather than NaN for too little data', () => {
    expect(mean([])).toBeUndefined()
    expect(median([])).toBeUndefined()
    expect(stdev([5])).toBeUndefined()
  })

  it('rounds to a number of digits', () => {
    expect(round(1.23456, 2)).toBe(1.23)
    expect(round(1.005, 4)).toBe(1.005)
  })
})

describe('paths', () => {
  it('expands ~ and resolves against a base', () => {
    expect(expandHome('~/x')).toBe(path.join(os.homedir(), 'x'))
    expect(expandHome('/abs')).toBe('/abs')
    expect(resolvePath('rel', '/base')).toBe('/base/rel')
    expect(resolvePath('/abs', '/base')).toBe('/abs')
  })
})

describe('hashing', () => {
  it('stringifies with sorted keys at every depth', () => {
    expect(stableStringify({ b: 1, a: { d: 1, c: [{ y: 1, x: 2 }] } })).toBe('{"a":{"c":[{"x":2,"y":1}],"d":1},"b":1}')
  })

  it('hashes equal values equally and different values differently', () => {
    expect(shortHash({ a: 1, b: 2 })).toBe(shortHash({ b: 2, a: 1 }))
    expect(shortHash({ a: 1 })).not.toBe(shortHash({ a: 2 }))
    expect(shortHash({ a: 1 })).toHaveLength(8)
  })

  it('slugifies labels for file names', () => {
    expect(slugify('Fast lane / no lenses!')).toBe('fast-lane-no-lenses')
    expect(slugify('---')).toBe('')
    expect(slugify('x'.repeat(100))).toHaveLength(40)
  })
})

describe('tailLines', () => {
  it('keeps the last n lines', () => {
    expect(tailLines('a\nb\nc\nd', 2)).toBe('c\nd')
    expect(tailLines('a', 5)).toBe('a')
  })
})

describe('mapPool', () => {
  it('returns results in input order', async () => {
    const out = await mapPool([30, 10, 20], 3, async n => {
      await new Promise(resolve => setTimeout(resolve, n))
      return n * 2
    })
    expect(out).toEqual([60, 20, 40])
  })

  it('never runs more than `limit` at once', async () => {
    let running = 0
    let peak = 0
    await mapPool(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, 5))
      running--
    })
    expect(peak).toBe(3)
  })

  it('handles an empty list', async () => {
    expect(await mapPool([], 4, async () => 1)).toEqual([])
  })
})

describe('runShell', () => {
  const cwd = os.tmpdir()

  it('captures combined output and the exit code', async () => {
    const result = await runShell('echo out; echo err 1>&2; exit 3', { cwd })
    expect(result.exitCode).toBe(3)
    expect(result.output).toContain('out')
    expect(result.output).toContain('err')
    expect(result.timedOut).toBe(false)
  })

  it('passes the environment it is given, and nothing else', async () => {
    const result = await runShell('echo "[$ONLY_ME][$HOME]"', { cwd, env: { ONLY_ME: 'yes', PATH: process.env['PATH'] } })
    expect(result.output.trim()).toBe('[yes][]')
  })

  it('kills the whole process group on timeout', async () => {
    const started = Date.now()
    const result = await runShell('sleep 30 & sleep 30', { cwd, timeoutMs: 300 })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('keeps the end of very long output and reports how much there was', async () => {
    const result = await runShell('i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done', { cwd, maxOutputBytes: 1_000 })
    expect(result.output.length).toBeLessThanOrEqual(1_000)
    expect(result.output).toContain('line-1999')
    expect(result.output).not.toContain('line-0\n')
    expect(result.outputBytes).toBeGreaterThan(1_000)
  })

  it('reports a command that cannot start', async () => {
    const result = await runShell('true', { cwd: '/definitely/not/a/directory' })
    expect(result.exitCode).not.toBe(0)
  })
})

describe('reservePort', () => {
  it('hands out distinct ports', async () => {
    const ports = await Promise.all(Array.from({ length: 8 }, () => reservePort()))
    expect(new Set(ports).size).toBe(8)
    for (const port of ports) expect(port).toBeGreaterThan(1023)
  })
})
