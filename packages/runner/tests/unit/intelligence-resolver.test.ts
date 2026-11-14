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
  await fs.mkdir(path.join(layerDir, '.claude', 'agents'), { recursive: true })
  await fs.mkdir(path.join(layerDir, '.claude', 'commands', 'coro'), { recursive: true })
  await fs.mkdir(path.join(layerDir, '.claude', 'memory'), { recursive: true })

  await fs.writeFile(path.join(layerDir, '.claude', 'CLAUDE.md'), '# Coro Agent Runtime Instructions\n')
  await fs.writeFile(path.join(layerDir, '.claude', 'skills', 'foo', 'SKILL.md'), '# Foo skill\n')
  await fs.writeFile(path.join(layerDir, '.claude', 'agents', 'planner.md'), '# Planner\n')
  await fs.writeFile(path.join(layerDir, '.claude', 'commands', 'coro', 'job.md'), '---\nphases: []\n---\n')
  await fs.writeFile(path.join(layerDir, '.claude', 'memory', 'MEMORY.md'), '# Memory index\n')
}

describe('resolveJobIntelligence — base layer', () => {
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
      path.join(result.intelligenceDir, '.claude', 'commands', 'coro', 'job.md'),
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
    await fs.writeFile(path.join(baseLayerDir, '.claude', 'agents', '.DS_Store'), 'mac noise')

    const result = await resolveJobIntelligence({
      baseLayerDir,
      tenantContext: synthesizeSoloTenant(),
      jobId: 'job-ds-store',
      workingRoot: path.join(workspaceRoot, 'working'),
      logger: noopLogger,
    })

    await expect(fs.access(path.join(result.intelligenceDir, '.DS_Store'))).rejects.toThrow()
    await expect(fs.access(path.join(result.intelligenceDir, '.claude', 'agents', '.DS_Store'))).rejects.toThrow()
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

describe('resolveJobIntelligence — tenant overlay (localDir)', () => {
  it('stacks tenant overlay onto base with last-wins for replace files', async () => {
    const baseLayerDir = path.join(workspaceRoot, 'base-layer')
    await writeBaseLayer(baseLayerDir)

    // Tenant overrides the planner agent and adds a new file.
    const tenantDir = path.join(workspaceRoot, 'tenant-overlay')
    await fs.mkdir(path.join(tenantDir, '.claude', 'agents'), { recursive: true })
    await fs.writeFile(path.join(tenantDir, '.claude', 'agents', 'planner.md'), '# Tenant planner\n')
    await fs.mkdir(path.join(tenantDir, '.claude', 'commands', 'coro'), { recursive: true })
    await fs.writeFile(path.join(tenantDir, '.claude', 'commands', 'coro', 'tenant-only.md'), '---\nphases: [a]\n---\n')

    const tenant: TenantContext = {
      ...synthesizeSoloTenant(),
      overlay: { kind: 'localDir', path: tenantDir },
    }

    const result = await resolveJobIntelligence({
      baseLayerDir,
      tenantContext: tenant,
      jobId: 'job-overlay-localdir',
      workingRoot: path.join(workspaceRoot, 'working'),
      logger: noopLogger,
    })

    expect(result.layers).toHaveLength(2)
    expect(result.layers[1]?.name).toMatch(/^tenant:/)
    expect(result.layers[1]?.source).toBe(tenantDir)

    const planner = await fs.readFile(
      path.join(result.intelligenceDir, '.claude', 'agents', 'planner.md'),
      'utf8',
    )
    expect(planner).toContain('Tenant planner')
    expect(planner).not.toContain('# Planner') // base content fully replaced

    const tenantOnly = await fs.readFile(
      path.join(result.intelligenceDir, '.claude', 'commands', 'coro', 'tenant-only.md'),
      'utf8',
    )
    expect(tenantOnly).toContain('phases: [a]')
  })

  it('appends tenant CLAUDE.md and memory contributions', async () => {
    const baseLayerDir = path.join(workspaceRoot, 'base-layer')
    await writeBaseLayer(baseLayerDir)

    const tenantDir = path.join(workspaceRoot, 'tenant-overlay')
    await fs.mkdir(path.join(tenantDir, '.claude'), { recursive: true })
    await fs.writeFile(path.join(tenantDir, '.claude', 'CLAUDE.md'), '# Tenant additions\n\ntenant-specific guidance.')
    await fs.mkdir(path.join(tenantDir, '.claude', 'memory'), { recursive: true })
    await fs.writeFile(path.join(tenantDir, '.claude', 'memory', 'MEMORY.md'), '# Tenant memory entry\n')

    const tenant: TenantContext = {
      ...synthesizeSoloTenant(),
      overlay: { kind: 'localDir', path: tenantDir },
    }

    const result = await resolveJobIntelligence({
      baseLayerDir,
      tenantContext: tenant,
      jobId: 'job-append',
      workingRoot: path.join(workspaceRoot, 'working'),
      logger: noopLogger,
    })

    const claudeMd = await fs.readFile(
      path.join(result.intelligenceDir, '.claude', 'CLAUDE.md'),
      'utf8',
    )
    expect(claudeMd).toContain('Coro Agent Runtime Instructions')
    expect(claudeMd).toContain('Tenant additions')
    expect(claudeMd.indexOf('Coro Agent Runtime Instructions')).toBeLessThan(
      claudeMd.indexOf('Tenant additions'),
    )

    const memoryMd = await fs.readFile(path.join(result.intelligenceDir, '.claude', 'memory', 'MEMORY.md'), 'utf8')
    expect(memoryMd).toContain('Memory index')
    expect(memoryMd).toContain('Tenant memory entry')
  })

  it('skips the tenant layer when localDir does not exist (warns, no crash)', async () => {
    const baseLayerDir = path.join(workspaceRoot, 'base-layer')
    await writeBaseLayer(baseLayerDir)

    const warn = vi.fn()
    const logger = { ...noopLogger, warn } as unknown as import('pino').Logger

    const tenant: TenantContext = {
      ...synthesizeSoloTenant(),
      overlay: { kind: 'localDir', path: path.join(workspaceRoot, 'missing-overlay') },
    }
    const result = await resolveJobIntelligence({
      baseLayerDir,
      tenantContext: tenant,
      jobId: 'job-overlay-missing',
      workingRoot: path.join(workspaceRoot, 'working'),
      logger,
    })
    expect(result.layers).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
  })

  it('skips the tenant layer when overlay kind is none (default)', async () => {
    const baseLayerDir = path.join(workspaceRoot, 'base-layer')
    await writeBaseLayer(baseLayerDir)

    const result = await resolveJobIntelligence({
      baseLayerDir,
      tenantContext: synthesizeSoloTenant(),
      jobId: 'job-no-overlay',
      workingRoot: path.join(workspaceRoot, 'working'),
      logger: noopLogger,
    })
    expect(result.layers).toHaveLength(1)
    expect(result.layers[0]?.name).toBe('base')
  })

  it('cloudBlob overlay kind warns and falls back to base-only (Phase 5 stub)', async () => {
    const baseLayerDir = path.join(workspaceRoot, 'base-layer')
    await writeBaseLayer(baseLayerDir)
    const warn = vi.fn()
    const logger = { ...noopLogger, warn } as unknown as import('pino').Logger

    const tenant: TenantContext = {
      ...tenantFromTeamId('abc'),
      overlay: { kind: 'cloudBlob', key: 'tenant/abc/v1' },
    }
    const result = await resolveJobIntelligence({
      baseLayerDir,
      tenantContext: tenant,
      jobId: 'job-cloud',
      workingRoot: path.join(workspaceRoot, 'working'),
      logger,
    })
    expect(result.layers).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
  })
})

describe('resolveJobIntelligence — Claude Code standalone blocks', () => {
  const START = '<!-- standalone:start -->'
  const END = '<!-- standalone:end -->'

  async function resolveWithTenant(jobId: string, tenantDir: string | null, baseLayerDir: string) {
    const tenant: TenantContext =
      tenantDir === null
        ? synthesizeSoloTenant()
        : { ...synthesizeSoloTenant(), overlay: { kind: 'localDir', path: tenantDir } }
    return resolveJobIntelligence({
      baseLayerDir,
      tenantContext: tenant,
      jobId,
      workingRoot: path.join(workspaceRoot, 'working'),
      logger: noopLogger,
    })
  }

  it('removes standalone blocks from every markdown file of the base layer', async () => {
    const baseLayerDir = path.join(workspaceRoot, 'base-layer')
    await writeBaseLayer(baseLayerDir)
    await fs.writeFile(
      path.join(baseLayerDir, '.claude', 'CLAUDE.md'),
      `# Rules\n\nAlways follow these.\n\n${START}\n## Running without the Coro runner\n\nUse Bash.\n${END}\n`,
    )
    await fs.writeFile(
      path.join(baseLayerDir, '.claude', 'agents', 'planner.md'),
      `---\nname: planner\ndescription: Plans.\n---\n\n# Agent: Planner\n\n${START}\nOutside the runner, see CLAUDE.md.\n${END}\n\n## Role\n`,
    )

    const result = await resolveWithTenant('job-standalone-base', null, baseLayerDir)

    const claudeMd = await fs.readFile(path.join(result.intelligenceDir, '.claude', 'CLAUDE.md'), 'utf8')
    expect(claudeMd).toContain('Always follow these.')
    expect(claudeMd).not.toContain('standalone')
    expect(claudeMd).not.toContain('Running without the Coro runner')

    const planner = await fs.readFile(
      path.join(result.intelligenceDir, '.claude', 'agents', 'planner.md'),
      'utf8',
    )
    expect(planner).toContain('## Role')
    expect(planner).not.toContain('standalone')
    expect(planner).not.toContain('Outside the runner')
  })

  it('strips blocks that arrive from a tenant overlay as well', async () => {
    const baseLayerDir = path.join(workspaceRoot, 'base-layer')
    await writeBaseLayer(baseLayerDir)
    const tenantDir = path.join(workspaceRoot, 'tenant-overlay')
    await fs.mkdir(path.join(tenantDir, '.claude', 'agents'), { recursive: true })
    await fs.writeFile(
      path.join(tenantDir, '.claude', 'agents', 'planner.md'),
      `# Tenant planner\n\n${START}\nclaude-code only\n${END}\n\nKept.\n`,
    )

    const result = await resolveWithTenant('job-standalone-tenant', tenantDir, baseLayerDir)

    const planner = await fs.readFile(
      path.join(result.intelligenceDir, '.claude', 'agents', 'planner.md'),
      'utf8',
    )
    expect(planner).toContain('Kept.')
    expect(planner).not.toContain('claude-code only')
    expect(planner).not.toContain('standalone')
  })

  it('does not touch the source layer on disk', async () => {
    const baseLayerDir = path.join(workspaceRoot, 'base-layer')
    await writeBaseLayer(baseLayerDir)
    const source = `# Rules\n\n${START}\nstandalone text\n${END}\n`
    await fs.writeFile(path.join(baseLayerDir, '.claude', 'CLAUDE.md'), source)

    await resolveWithTenant('job-standalone-source', null, baseLayerDir)

    expect(await fs.readFile(path.join(baseLayerDir, '.claude', 'CLAUDE.md'), 'utf8')).toBe(source)
  })

  it('appends the tenant runtime contract after the base one', async () => {
    const baseLayerDir = path.join(workspaceRoot, 'base-layer')
    await writeBaseLayer(baseLayerDir)
    await fs.mkdir(path.join(baseLayerDir, '.claude', 'coro'), { recursive: true })
    await fs.writeFile(path.join(baseLayerDir, '.claude', 'coro', 'RUNTIME.md'), '# Base runtime contract\n')
    const tenantDir = path.join(workspaceRoot, 'tenant-overlay')
    await fs.mkdir(path.join(tenantDir, '.claude', 'coro'), { recursive: true })
    await fs.writeFile(path.join(tenantDir, '.claude', 'coro', 'RUNTIME.md'), '# Tenant runtime addition\n')

    const result = await resolveWithTenant('job-runtime', tenantDir, baseLayerDir)

    const runtime = await fs.readFile(
      path.join(result.intelligenceDir, '.claude', 'coro', 'RUNTIME.md'),
      'utf8',
    )
    expect(runtime).toContain('Base runtime contract')
    expect(runtime).toContain('Tenant runtime addition')
    expect(runtime.indexOf('Base runtime contract')).toBeLessThan(runtime.indexOf('Tenant runtime addition'))
  })
})

describe('resolveJobIntelligence — repo overlay (.coro/)', () => {
  it('stacks repo .coro/ as the topmost layer when present', async () => {
    const baseLayerDir = path.join(workspaceRoot, 'base-layer')
    await writeBaseLayer(baseLayerDir)

    const repoCheckoutDir = path.join(workspaceRoot, 'repo')
    await fs.mkdir(path.join(repoCheckoutDir, '.coro', '.claude', 'agents'), { recursive: true })
    await fs.writeFile(
      path.join(repoCheckoutDir, '.coro', '.claude', 'agents', 'planner.md'),
      '# Repo-pinned planner\n',
    )

    const result = await resolveJobIntelligence({
      baseLayerDir,
      tenantContext: synthesizeSoloTenant(),
      jobId: 'job-repo',
      workingRoot: path.join(workspaceRoot, 'working'),
      repoCheckoutDir,
      logger: noopLogger,
    })

    expect(result.layers.map(l => l.name)).toEqual(['base', 'repo'])
    const planner = await fs.readFile(
      path.join(result.intelligenceDir, '.claude', 'agents', 'planner.md'),
      'utf8',
    )
    expect(planner).toContain('Repo-pinned planner')
  })

  it('opportunistically skips repo layer when checkout dir does not exist yet', async () => {
    const baseLayerDir = path.join(workspaceRoot, 'base-layer')
    await writeBaseLayer(baseLayerDir)

    const result = await resolveJobIntelligence({
      baseLayerDir,
      tenantContext: synthesizeSoloTenant(),
      jobId: 'job-repo-missing',
      workingRoot: path.join(workspaceRoot, 'working'),
      // Repo not yet cloned (typical state at job start) — must NOT crash.
      repoCheckoutDir: path.join(workspaceRoot, 'not-cloned-yet'),
      logger: noopLogger,
    })
    expect(result.layers).toHaveLength(1)
    expect(result.layers[0]?.name).toBe('base')
  })

  it('does NOT pull from the repo .claude/ directory (left for Claude Code native loader)', async () => {
    const baseLayerDir = path.join(workspaceRoot, 'base-layer')
    await writeBaseLayer(baseLayerDir)

    const repoCheckoutDir = path.join(workspaceRoot, 'repo-with-claude-only')
    // Repo has a .claude/ but NO .coro/ — the resolver should treat the repo
    // overlay as absent because that .claude is the Claude Code SDK's domain.
    await fs.mkdir(path.join(repoCheckoutDir, '.claude'), { recursive: true })
    await fs.writeFile(
      path.join(repoCheckoutDir, '.claude', 'CLAUDE.md'),
      '# REPO CLAUDE — must not be merged by resolver',
    )

    const result = await resolveJobIntelligence({
      baseLayerDir,
      tenantContext: synthesizeSoloTenant(),
      jobId: 'job-repo-claude-only',
      workingRoot: path.join(workspaceRoot, 'working'),
      repoCheckoutDir,
      logger: noopLogger,
    })

    expect(result.layers).toHaveLength(1)
    expect(result.layers[0]?.name).toBe('base')

    // Crucially the materialised CLAUDE.md must NOT contain the repo's content.
    const claudeMd = await fs.readFile(
      path.join(result.intelligenceDir, '.claude', 'CLAUDE.md'),
      'utf8',
    )
    expect(claudeMd).not.toContain('REPO CLAUDE')
  })

  it('stacks all three layers (base + tenant + repo) with deterministic precedence', async () => {
    const baseLayerDir = path.join(workspaceRoot, 'base-layer')
    await writeBaseLayer(baseLayerDir)

    const tenantDir = path.join(workspaceRoot, 'tenant')
    await fs.mkdir(path.join(tenantDir, '.claude', 'agents'), { recursive: true })
    await fs.writeFile(path.join(tenantDir, '.claude', 'agents', 'planner.md'), '# Tenant planner\n')

    const repoCheckoutDir = path.join(workspaceRoot, 'repo')
    await fs.mkdir(path.join(repoCheckoutDir, '.coro', '.claude', 'agents'), { recursive: true })
    await fs.writeFile(
      path.join(repoCheckoutDir, '.coro', '.claude', 'agents', 'planner.md'),
      '# Repo planner (final)\n',
    )

    const tenant: TenantContext = {
      ...synthesizeSoloTenant(),
      overlay: { kind: 'localDir', path: tenantDir },
    }
    const result = await resolveJobIntelligence({
      baseLayerDir,
      tenantContext: tenant,
      jobId: 'job-three-layer',
      workingRoot: path.join(workspaceRoot, 'working'),
      repoCheckoutDir,
      logger: noopLogger,
    })

    expect(result.layers).toHaveLength(3)
    expect(result.layers.map(l => l.name)).toEqual([
      'base',
      expect.stringMatching(/^tenant:/),
      'repo',
    ])

    const planner = await fs.readFile(
      path.join(result.intelligenceDir, '.claude', 'agents', 'planner.md'),
      'utf8',
    )
    expect(planner).toContain('Repo planner (final)')
    expect(planner).not.toContain('Tenant planner')
    expect(planner).not.toContain('# Planner') // base content fully replaced
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
