import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyOverrides,
  findScenarioFile,
  laneWorkflowPath,
  listScenarios,
  loadScenario,
  parseOverride,
  resolveScenario,
  scenarioHash,
} from '../src/scenario'
import { tmpDir, write } from './helpers/tmp'

describe('parseOverride', () => {
  it('reads JSON values as JSON and everything else as a string', () => {
    expect(parseOverride('repeat=5').value).toBe(5)
    expect(parseOverride('judge.enabled=false').value).toBe(false)
    expect(parseOverride('tenantOverlayDir=null').value).toBeNull()
    expect(parseOverride('models.coding=claude-sonnet-5-5').value).toBe('claude-sonnet-5-5')
    expect(parseOverride('coroPath=/abs/path').value).toBe('/abs/path')
    expect(parseOverride('x=["a","b"]').value).toEqual(['a', 'b'])
  })

  it('keeps everything after the first equals sign', () => {
    expect(parseOverride('a.b=c=d').value).toBe('c=d')
  })

  it('splits the key on dots', () => {
    expect(parseOverride('judge.model=m').path).toEqual(['judge', 'model'])
  })

  it('rejects malformed expressions', () => {
    expect(() => parseOverride('nokey')).toThrow(/key=value/)
    expect(() => parseOverride('=5')).toThrow(/key=value/)
    expect(() => parseOverride('a..b=1')).toThrow(/empty segment/)
  })

  it('rejects keys that could pollute prototypes', () => {
    for (const key of ['__proto__.x', 'a.__proto__.x', 'constructor.prototype.x', 'a.prototype']) {
      expect(() => parseOverride(`${key}=1`), key).toThrow(/not allowed/)
    }
  })
})

describe('applyOverrides', () => {
  it('does not change its input', () => {
    const base = { judge: { enabled: true } }
    const result = applyOverrides(base, ['judge.enabled=false'])
    expect(base.judge.enabled).toBe(true)
    expect(result).toEqual({ judge: { enabled: false } })
  })

  it('creates intermediate objects', () => {
    expect(applyOverrides({}, ['models.coding=a', 'models.planning=b'])).toEqual({ models: { coding: 'a', planning: 'b' } })
  })

  it('replaces a non-object that is in the way', () => {
    expect(applyOverrides({ judge: 5 }, ['judge.model=m'])).toEqual({ judge: { model: 'm' } })
  })

  it('applies later overrides over earlier ones', () => {
    expect(applyOverrides({}, ['lane=fast', 'lane=deep'])).toEqual({ lane: 'deep' })
  })

  it('cannot pollute Object.prototype', () => {
    expect(() => applyOverrides({}, ['__proto__.polluted=yes'])).toThrow()
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })
})

describe('resolveScenario', () => {
  it('fills in every default', () => {
    const scenario = resolveScenario()
    expect(scenario).toMatchObject({
      lane: 'standard',
      models: {},
      tenantOverlayDir: null,
      codeReviewLenses: true,
      repeat: 3,
      parallel: 2,
      judge: { enabled: true, provider: 'anthropic', samples: 1 },
      reviewer: { approveAfterSeconds: 0 },
    })
    expect(scenario.judge.model).toBeTruthy()
  })

  it('layers file, flags, then --set, each winning over the last', () => {
    const scenario = resolveScenario({
      base: { lane: 'fast', repeat: 2, parallel: 1 },
      flags: { repeat: 4, parallel: undefined },
      overrides: ['lane=deep'],
    })
    expect(scenario.lane).toBe('deep')
    expect(scenario.repeat).toBe(4)
    expect(scenario.parallel).toBe(1)
  })

  it('refuses an unknown key, so a typo cannot silently run the baseline', () => {
    expect(() => resolveScenario({ overrides: ['lanee=fast'] })).toThrow(/Invalid scenario[\s\S]*lanee/)
    expect(() => resolveScenario({ overrides: ['judge.modle=x'] })).toThrow(/Invalid scenario/)
  })

  it('refuses a value of the wrong type or range', () => {
    expect(() => resolveScenario({ overrides: ['lane=turbo'] })).toThrow(/lane/)
    expect(() => resolveScenario({ overrides: ['repeat=0'] })).toThrow(/repeat/)
    expect(() => resolveScenario({ overrides: ['repeat=1.5'] })).toThrow(/repeat/)
    expect(() => resolveScenario({ overrides: ['judge.samples=20'] })).toThrow(/samples/)
  })

  it('accepts model tiers with colons and dots in the name', () => {
    expect(resolveScenario({ overrides: ['models.coding=a'] }).models).toEqual({ coding: 'a' })
    expect(() => resolveScenario({ base: { models: { '': 'a' } } })).toThrow()
  })
})

describe('scenarioHash', () => {
  it('is the same for the same scenario', () => {
    expect(scenarioHash(resolveScenario())).toBe(scenarioHash(resolveScenario()))
  })

  it('does not depend on key order', () => {
    const a = resolveScenario({ base: { lane: 'fast', models: { coding: 'a', planning: 'b' } } })
    const b = resolveScenario({ base: { models: { planning: 'b', coding: 'a' }, lane: 'fast' } })
    expect(scenarioHash(a)).toBe(scenarioHash(b))
  })

  it('changes when something that affects Coro changes', () => {
    const base = scenarioHash(resolveScenario())
    expect(scenarioHash(resolveScenario({ overrides: ['lane=fast'] }))).not.toBe(base)
    expect(scenarioHash(resolveScenario({ overrides: ['models.coding=x'] }))).not.toBe(base)
    expect(scenarioHash(resolveScenario({ overrides: ['codeReviewLenses=false'] }))).not.toBe(base)
    expect(scenarioHash(resolveScenario({ overrides: ['tenantOverlayDir=/tmp/overlay'] }))).not.toBe(base)
    expect(scenarioHash(resolveScenario({ overrides: ['judge.model=other'] }))).not.toBe(base)
  })

  it('ignores settings that only change how the harness runs', () => {
    const base = scenarioHash(resolveScenario())
    expect(scenarioHash(resolveScenario({ overrides: ['repeat=9'] }))).toBe(base)
    expect(scenarioHash(resolveScenario({ overrides: ['parallel=8'] }))).toBe(base)
    expect(scenarioHash(resolveScenario({ overrides: ['reviewer.approveAfterSeconds=30'] }))).toBe(base)
    expect(scenarioHash(resolveScenario({ overrides: ['pollIntervalSeconds=1'] }))).toBe(base)
  })
})

describe('scenario files', () => {
  it('finds a scenario by name in a directory', () => {
    const dir = tmpDir()
    write(dir, 'fast.yaml', 'lane: fast\n')
    write(dir, 'other.json', '{"lane":"deep"}')
    expect(findScenarioFile('fast', dir)).toBe(path.join(dir, 'fast.yaml'))
    expect(findScenarioFile('other', dir)).toBe(path.join(dir, 'other.json'))
    expect(listScenarios(dir)).toEqual(['fast', 'other'])
  })

  it('names the alternatives when a scenario is missing', () => {
    const dir = tmpDir()
    write(dir, 'fast.yaml', 'lane: fast\n')
    expect(() => findScenarioFile('nope', dir)).toThrow(/available: fast/)
  })

  it('accepts a path to a file', () => {
    const dir = tmpDir()
    const file = write(dir, 'custom.yaml', 'lane: deep\nrepeat: 2\n')
    const { scenario } = loadScenario(file, { overrides: ['repeat=7'] })
    expect(scenario.lane).toBe('deep')
    expect(scenario.repeat).toBe(7)
  })

  it('rejects a file whose top level is not a mapping', () => {
    const dir = tmpDir()
    write(dir, 'bad.yaml', '- a\n- b\n')
    expect(() => loadScenario('bad', {}, dir)).toThrow(/mapping/)
  })

  it('treats an empty file as all defaults', () => {
    const dir = tmpDir()
    write(dir, 'empty.yaml', '')
    expect(loadScenario('empty', {}, dir).scenario.lane).toBe('standard')
  })

  it('ships a valid baseline scenario', () => {
    expect(listScenarios()).toContain('baseline')
    const { scenario } = loadScenario('baseline')
    expect(scenario.lane).toBe('standard')
  })
})

describe('laneWorkflowPath', () => {
  it('maps lanes to the workflow files Coro ships', () => {
    expect(laneWorkflowPath('standard')).toBe('.claude/commands/coro/job.md')
    expect(laneWorkflowPath('fast')).toBe('.claude/commands/coro/job-fast.md')
    expect(laneWorkflowPath('deep')).toBe('.claude/commands/coro/job-deep.md')
  })
})
