import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { loadLocalConfig } from '../../src/config/local-config'
import { incrementCoachModeRunCount } from '../../src/config/coach-mode'

describe('incrementCoachModeRunCount', () => {
  let tmpDir: string
  let configPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-coach-'))
    configPath = path.join(tmpDir, 'config.json')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('increments totalRuns and sets lastRunAt on empty config', () => {
    incrementCoachModeRunCount(configPath)
    const config = loadLocalConfig(configPath)
    expect(config?.coachMode?.totalRuns).toBe(1)
    expect(config?.coachMode?.enabled).toBe(true)
    expect(config?.coachMode?.graduateAfterRuns).toBe(5)
    expect(config?.coachMode?.lastRunAt).toMatch(/^\d{4}-/)
  })

  it('preserves existing coach fields while incrementing', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        coachMode: {
          enabled: false,
          graduateAfterRuns: 10,
          totalRuns: 3,
          graduatedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    )

    incrementCoachModeRunCount(configPath)
    const config = loadLocalConfig(configPath)
    expect(config?.coachMode?.totalRuns).toBe(4)
    expect(config?.coachMode?.enabled).toBe(false)
    expect(config?.coachMode?.graduateAfterRuns).toBe(10)
    expect(config?.coachMode?.graduatedAt).toBe('2026-01-01T00:00:00.000Z')
  })
})
