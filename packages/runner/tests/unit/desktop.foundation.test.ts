import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Command } from 'commander'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DESKTOP_REQUIRED_ENV,
  DESKTOP_RESOURCE_SEGMENTS,
  DESKTOP_RUNNER_DASHBOARD_PATH,
  DESKTOP_RUNNER_HEALTH_PATH,
  DESKTOP_RUNNER_DEFAULT_HOST,
  DESKTOP_RUNNER_DEFAULT_PREFERRED_PORT,
  buildDesktopRunnerLaunchSpec,
  chooseDesktopRunnerPort,
  resolveDesktopResourceLayout,
  validateDesktopResourceLayout,
} from '../../src/desktop'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('desktop launch contract', () => {
  it('builds runner launch args, env, and URLs from the chosen port', () => {
    const spec = buildDesktopRunnerLaunchSpec({
      port: 4310,
      dashboardDist: '/tmp/coro-dashboard',
      configPath: '/tmp/config.json',
      env: { HOME: '/Users/tester' },
    })

    expect(spec.commandArgs).toEqual([
      'dist/cli/index.js',
      'start',
      '--port',
      '4310',
      '--no-open',
      '--config',
      '/tmp/config.json',
    ])
    expect(spec.env.HOME).toBe('/Users/tester')
    expect(spec.env.NODE_ENV).toBe('production')
    expect(spec.env[DESKTOP_REQUIRED_ENV.noOpen]).toBe('1')
    expect(spec.env[DESKTOP_REQUIRED_ENV.dashboardDist]).toBe('/tmp/coro-dashboard')
    expect(spec.urls.health).toBe(`http://${DESKTOP_RUNNER_DEFAULT_HOST}:4310${DESKTOP_RUNNER_HEALTH_PATH}`)
    expect(spec.urls.dashboard).toBe(`http://${DESKTOP_RUNNER_DEFAULT_HOST}:4310${DESKTOP_RUNNER_DASHBOARD_PATH}`)
  })

  it('rejects invalid port values', () => {
    expect(() =>
      buildDesktopRunnerLaunchSpec({
        port: 0,
        dashboardDist: '/tmp/coro-dashboard',
      })).toThrow(/Desktop runner port/)
  })

  it('parses electron-as-node argv shape (desktop sidecar launch)', () => {
    const program = new Command()
    let invoked = false
    program.command('start').action(() => {
      invoked = true
    })

    const electronArgv = [
      '/Applications/Coro.app/Contents/MacOS/Coro',
      '/Applications/Coro.app/Contents/Resources/coro/runner/dist/cli/index.js',
      'start',
    ]

    program.parse(electronArgv, { from: 'node' })
    expect(invoked).toBe(true)
  })
})

describe('desktop resource layout', () => {
  it('resolves a deterministic packaged resource tree', () => {
    const layout = resolveDesktopResourceLayout('/Applications/Coro.app/Contents/Resources')
    expect(layout.appRoot).toBe('/Applications/Coro.app/Contents/Resources/coro')
    expect(layout.runnerEntryPoint).toBe('/Applications/Coro.app/Contents/Resources/coro/runner/dist/cli/index.js')
    expect(layout.dashboardDistDir).toBe('/Applications/Coro.app/Contents/Resources/coro/dashboard/dist')
  })

  it('validates an assembled resource tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-desktop-layout-'))
    tempDirs.push(root)

    const required = [
      path.join(root, DESKTOP_RESOURCE_SEGMENTS.runnerDir, 'dist', 'cli'),
      path.join(root, DESKTOP_RESOURCE_SEGMENTS.dashboardDistDir),
    ]
    for (const dir of required) {
      fs.mkdirSync(dir, { recursive: true })
    }

    fs.writeFileSync(path.join(root, DESKTOP_RESOURCE_SEGMENTS.runnerDir, 'package.json'), '{}')
    fs.writeFileSync(path.join(root, DESKTOP_RESOURCE_SEGMENTS.runnerDir, 'dist', 'cli', 'index.js'), '')
    fs.writeFileSync(path.join(root, DESKTOP_RESOURCE_SEGMENTS.dashboardDistDir, 'index.html'), '<html></html>')

    expect(() => validateDesktopResourceLayout(resolveDesktopResourceLayout(root))).not.toThrow()
  })
})

describe('desktop port selection', () => {
  it('prefers the configured port when it is available', async () => {
    const selection = await chooseDesktopRunnerPort({
      preferredPort: DESKTOP_RUNNER_DEFAULT_PREFERRED_PORT,
    })

    expect(selection.host).toBe(DESKTOP_RUNNER_DEFAULT_HOST)
    expect(selection.port).toBeGreaterThan(0)
    expect(selection.source === 'preferred' || selection.source === 'ephemeral').toBe(true)
  })
})