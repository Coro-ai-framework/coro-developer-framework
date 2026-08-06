import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { probeHostSandbox } from '../src/sandbox-probe'

describe('probeHostSandbox', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'coro-sandbox-probe-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (name: string, body: unknown): string => {
    const file = path.join(dir, name)
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
    return file
  }

  it('returns null when no settings sources exist', () => {
    expect(probeHostSandbox({ sources: [path.join(dir, 'nope.json')] })).toBeNull()
  })

  it('returns null when policy exists but does not enable the sandbox', () => {
    const file = write('managed.json', { permissions: { ask: ['Bash(rm *)'] } })
    expect(probeHostSandbox({ sources: [file] })).toBeNull()
  })

  it('returns null when the policy explicitly disables the sandbox', () => {
    const file = write('managed.json', { sandbox: { enabled: false } })
    expect(probeHostSandbox({ sources: [file] })).toBeNull()
  })

  it('reports an enforced sandbox and cites the source file', () => {
    const file = write('remote.json', { sandbox: { enabled: true } })
    const report = probeHostSandbox({ sources: [file] })
    expect(report).not.toBeNull()
    expect(report?.sources).toEqual([file])
    expect(report?.restrictsWritesOutsideWorkingDir).toBe(true)
  })

  it('surfaces the network allowlist, exemptions, and extra write paths', () => {
    const file = write('remote.json', {
      sandbox: {
        enabled: true,
        allowUnsandboxedCommands: false,
        excludedCommands: ['git'],
        filesystem: { allowWrite: ['~/go/**'] },
        network: { allowedDomains: ['github.com', 'bitbucket.org'] },
      },
    })
    const report = probeHostSandbox({ sources: [file] })
    expect(report?.allowedDomains).toEqual(['bitbucket.org', 'github.com'])
    expect(report?.excludedCommands).toEqual(['git'])
    expect(report?.allowWritePaths).toEqual(['~/go/**'])
    expect(report?.blocksUnsandboxedCommands).toBe(true)
  })

  it('merges every enabling source and omits absent fields', () => {
    const managed = write('managed.json', {
      sandbox: { enabled: true, network: { allowedDomains: ['github.com'] } },
    })
    const remote = write('remote.json', {
      sandbox: { enabled: true, network: { allowedDomains: ['bitbucket.org'] } },
    })
    const report = probeHostSandbox({ sources: [managed, remote] })
    expect(report?.sources).toEqual([managed, remote])
    expect(report?.allowedDomains).toEqual(['bitbucket.org', 'github.com'])
    expect(report?.excludedCommands).toBeUndefined()
    expect(report?.blocksUnsandboxedCommands).toBeUndefined()
  })

  it('ignores a source that enables the sandbox but defines no allowlist', () => {
    const file = write('remote.json', { sandbox: { enabled: true, network: {} } })
    expect(probeHostSandbox({ sources: [file] })?.allowedDomains).toBeUndefined()
  })

  it('treats malformed policy JSON as absent rather than throwing', () => {
    const file = write('broken.json', '{ not json')
    expect(() => probeHostSandbox({ sources: [file] })).not.toThrow()
    expect(probeHostSandbox({ sources: [file] })).toBeNull()
  })
})
