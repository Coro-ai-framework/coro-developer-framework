import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { planLocalOpen, resolveOpenablePath, type DetectedEditor } from '../../src/runner/open-editor'

describe('resolveOpenablePath', () => {
  let root: string
  let outside: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-open-root-'))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-open-outside-'))
    fs.mkdirSync(path.join(root, 'repos'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('accepts an existing path under a root, through the root’s own symlinks', () => {
    const result = resolveOpenablePath(path.join(root, 'repos'), [undefined, root])
    expect(result).toEqual({ ok: true, path: fs.realpathSync(path.join(root, 'repos')) })
  })

  it('refuses paths outside every root, including through a symlink inside one', () => {
    fs.symlinkSync(outside, path.join(root, 'escape'))
    expect(resolveOpenablePath(outside, [root])).toMatchObject({ ok: false, status: 403 })
    expect(resolveOpenablePath(path.join(root, 'escape'), [root])).toMatchObject({ ok: false, status: 403 })
    expect(resolveOpenablePath(path.join(root, '..', path.basename(outside)), [root])).toMatchObject({ ok: false, status: 403 })
  })

  it('refuses missing and relative paths', () => {
    expect(resolveOpenablePath(path.join(root, 'gone'), [root])).toMatchObject({ ok: false, status: 404 })
    expect(resolveOpenablePath('repos', [root])).toMatchObject({ ok: false, status: 400 })
  })
})

describe('planLocalOpen', () => {
  const code: DetectedEditor = { id: 'code', name: 'VS Code', cli: '/usr/local/bin/code', macApp: 'Visual Studio Code' }

  it('opens folders in the file manager but only reveals a macOS bundle', () => {
    expect(planLocalOpen('/s/repos/svc', true, 'darwin', undefined)).toEqual({ cmd: 'open', args: ['/s/repos/svc'], opened: 'folder' })
    expect(planLocalOpen('/s/Evil.app', true, 'darwin', undefined)).toEqual({ cmd: 'open', args: ['-R', '/s/Evil.app'], opened: 'reveal' })
    expect(planLocalOpen('/s/repos', true, 'linux', undefined).cmd).toBe('xdg-open')
  })

  it('opens files in the editor, and never hands them to the OS default handler', () => {
    expect(planLocalOpen('/s/run.command', false, 'darwin', code)).toEqual({ cmd: code.cli, args: ['/s/run.command'], opened: 'editor' })
    expect(planLocalOpen('/s/run.command', false, 'darwin', undefined)).toEqual({ cmd: 'open', args: ['-R', '/s/run.command'], opened: 'reveal' })
    expect(planLocalOpen('/s/run.sh', false, 'linux', undefined)).toEqual({ cmd: 'xdg-open', args: ['/s'], opened: 'reveal' })
  })
})
