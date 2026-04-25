import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  cleanupJobIntelligence,
  JOB_INTELLIGENCE_SUBDIR,
  resolveJobIntelligence,
} from '../../src/intelligence/resolver'
import {
  synthesizeSoloTenant,
  tenantFromTeamId,
  type TenantContext,
} from '../../src/intelligence/tenant-context'

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as import('pino').Logger

let workspaceRoot: string

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'coro-resolver-'))
})

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true })
  vi.clearAllMocks()
})

async function writeBaseLayer(layerDir: string): Promise<void> {
  await fs.mkdir(path.join(layerDir, '.claude'), { recursive: true })
  await fs.mkdir(path.join(layerDir, '.claude', 'skills', 'foo'), { recursive: true })
  await fs.mkdir(path.join(layerDir, 'agents'), { recursive: true })
  await fs.mkdir(path.join(layerDir, 'workflows', 'job'), { recursive: true })
  await fs.mkdir(path.join(layerDir, 'memory'), { recursive: true })

  await fs.writeFile(path.join(layerDir, '.claude', 'CLAUDE.md'), '# Coro Agent Runtime Instructions\n')
  await fs.writeFile(path.join(layerDir, '.claude', 'skills', 'foo', 'SKILL.md'), '# Foo skill\n')
  await fs.writeFile(path.join(layerDir, 'agents', 'planner.md'), '# Planner\n')
  await fs.writeFile(path.join(layerDir, 'workflows', 'job', 'workflow.md'), '---\nphases: []\n---\n')
  await fs.writeFile(path.join(layerDir, 'memory', 'MEMORY.md'), '# Memory index\n')
}

describe('resolveJobIntelligence (Phase 3 — base layer only)', () => {
  it('materialises a per-job overlay containing the base layer files', async () => {
    const baseLayerDir = path.join(workspaceRoot, 'base-layer')
    await writeBaseLayer(baseLayerDir)

    const tenant = synthesizeSoloTenant()
    const result = await resolveJobIntelligence({
      baseLayerDir,
      tenantContext: tenant,
      jobId: 'job-abc',
      workingRoot: path.join(workspaceRoot, 'working'),
      logger: noopLogger,
    })

    expect(result.intelligenceDir).toBe(
      path.resolve(workspaceRoot, 'working', 'job-abc', JOB_INTELLIGENCE_SUBDIR),
    )
    expect(result.tenantContext).toBe(tenant)
    expect(result.layers).toHaveLength(1)
    expect(result.layers[0]).toMatchObject({ name: 'base', source: baseLayerDir })
    expect(result.layers[0]?.fileCount).toBeGreaterThanOrEqual(5)

    const claudeMd = await fs.readFile(
      path.join(result.intelligenceDir, '.claude', 'CLAUDE.md'),
      'utf8',
    )
    expect(claudeMd).toContain('Coro Agent Runtime Instructions')

    const skill = await fs.readFile(
      path.join(result.intelligenceDir, '.claude', 'skills', 'foo', 'SKILL.md'),
      'utf8',
    )
    expect(skill).toContain('Foo skill')

    const workflow = await fs.readFile(
      path.join(result.intelligenceDir, 'workflows', 'job', 'workflow.md'),
      'utf8',
    )
    expect(workflow).toContain('phases:')
  })

  it('is idempotent — re-resolving the same jobId reproduces the dir from scratch', async () => {
    const baseLayerDir = path.join(workspaceRoot, 'base-layer')
    await writeBaseLayer(baseLayerDir)

    const tenant = synthesizeSoloTenant()
    const args = {
      baseLayerDir,
      tenantContext: tenant,
      jobId: 'job-idem',
      workingRoot: path.join(workspaceRoot, 'working'),
      logger: noopLogger,
    }
    const first = await resolveJobIntelligence(args)

    // Drop a file in the resolved dir and confirm a re-resolve wipes it.
    const stray = path.join(first.intelligenceDir, 'stray.txt')
    await fs.writeFile(stray, 'remove me')

    const second = await resolveJobIntelligence(args)
    expect(second.intelligenceDir).toBe(first.intelligenceDir)
    await expect(fs.access(stray)).rejects.toThrow()
  })

  it('treats a missing base layer dir as empty (no crash)', async () => {
    const tenant = synthesizeSoloTenant()
    const result = await resolveJobIntelligence({
      baseLayerDir: path.join(workspaceRoot, 'does-not-exist'),
      tenantContext: tenant,
      jobId: 'job-missing-base',
      workingRoot: path.join(workspaceRoot, 'working'),
      logger: noopLogger,
    })
    expect(result.layers[0]?.fileCount).toBe(0)
    const exists = await fs.stat(result.intelligenceDir)
    expect(exists.isDirectory()).toBe(true)
  })

  it('skips macOS .DS_Store files when copying the base layer', async () => {
    const baseLayerDir = path.join(workspaceRoot, 'base-layer')
    await writeBaseLayer(baseLayerDir)
    await fs.writeFile(path.join(baseLayerDir, '.DS_Store'), 'mac noise')
    await fs.writeFile(path.join(baseLayerDir, 'agents', '.DS_Store'), 'mac noise')

    const result = await resolveJobIntelligence({
      baseLayerDir,
      tenantContext: synthesizeSoloTenant(),
      jobId: 'job-ds-store',
      workingRoot: path.join(workspaceRoot, 'working'),
      logger: noopLogger,
    })

    await expect(fs.access(path.join(result.intelligenceDir, '.DS_Store'))).rejects.toThrow()
    await expect(fs.access(path.join(result.intelligenceDir, 'agents', '.DS_Store'))).rejects.toThrow()
  })

  it('warns when a tenant overlay is declared but no loader is wired (Phase 4)', async () => {
    const baseLayerDir = path.join(workspaceRoot, 'base-layer')
    await writeBaseLayer(baseLayerDir)
    const warn = vi.fn()
    const logger = { ...noopLogger, warn } as unknown as import('pino').Logger

    const tenant: TenantContext = {
      ...tenantFromTeamId('xyz'),
      overlay: { kind: 'localDir', path: '/tmp/whatever' },
    }
    const result = await resolveJobIntelligence({
      baseLayerDir,
      tenantContext: tenant,
      jobId: 'job-overlay-warn',
      workingRoot: path.join(workspaceRoot, 'working'),
      logger,
    })

    expect(result.layers).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ overlayKind: 'localDir', tenantId: 'team-xyz' }),
      expect.stringMatching(/overlay loader/i),
    )
  })

  it('rejects when jobId is empty', async () => {
    await expect(
      resolveJobIntelligence({
        baseLayerDir: path.join(workspaceRoot, 'base-layer'),
        tenantContext: synthesizeSoloTenant(),
        jobId: '',
        workingRoot: path.join(workspaceRoot, 'working'),
        logger: noopLogger,
      }),
    ).rejects.toThrow(/jobId is required/)
  })

  it('rejects when baseLayerDir is empty', async () => {
    await expect(
      resolveJobIntelligence({
        baseLayerDir: '',
        tenantContext: synthesizeSoloTenant(),
        jobId: 'job-no-base',
        workingRoot: path.join(workspaceRoot, 'working'),
        logger: noopLogger,
      }),
    ).rejects.toThrow(/baseLayerDir is required/)
  })
})

describe('cleanupJobIntelligence', () => {
  it('removes a previously materialised dir', async () => {
    const baseLayerDir = path.join(workspaceRoot, 'base-layer')
    await writeBaseLayer(baseLayerDir)
    const workingRoot = path.join(workspaceRoot, 'working')

    const result = await resolveJobIntelligence({
      baseLayerDir,
      tenantContext: synthesizeSoloTenant(),
      jobId: 'job-cleanup',
      workingRoot,
      logger: noopLogger,
    })

    await cleanupJobIntelligence({ workingRoot, jobId: 'job-cleanup', logger: noopLogger })

    await expect(fs.access(result.intelligenceDir)).rejects.toThrow()
  })

  it('is a no-op when the dir does not exist', async () => {
    await expect(
      cleanupJobIntelligence({
        workingRoot: path.join(workspaceRoot, 'never-created'),
        jobId: 'job-nope',
        logger: noopLogger,
      }),
    ).resolves.toBeUndefined()
  })
})
