import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  listProposals,
  proposeChange,
  routeFile,
  validateProposalFiles,
} from '../../src/tools/self-improvement'
import { JobType, emptyTokenUsage, type Job, type Proposal } from '../../src/jobs/types'
import type { ToolContext } from '../../src/tools/types'
import * as writerMock from '../../src/intelligence/writer'

// ── Mock the writer module ───────────────────────────────────────────────────
//
// `proposeChange` end-to-end is exercised in the integration test. Here
// we stub the writer so the unit tests focus on routing / validation /
// state-recording behaviour.

vi.mock('../../src/intelligence/writer', () => ({
  prepareTenantWriter: vi.fn(async () => ({
    dir: '/tmp/writer/tenant',
    baseRef: 'main',
    remoteUrl: 'git@github.com:acme/intel.git',
  })),
  prepareRepoWriter: vi.fn(async () => ({
    dir: '/tmp/working/job-1/my-repo',
    baseRef: 'main',
    remoteUrl: 'git@github.com:acme/my-repo.git',
  })),
  commitAndPush: vi.fn(async () => undefined),
  openProposalPr: vi.fn(async () => ({
    id: 17,
    url: 'https://github.com/acme/intel/pull/17',
    provider: 'github' as const,
  })),
}))

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: { repoSlug: 'my-repo' },
    triggerSource: 'cli',
    status: 'evaluation',
    phase: 'evaluation',
    currentWorkItem: null,
    workItems: [],
    workItemLoopCount: 0,
    prMappings: [],
    interactive: false,
    artifacts: [],
    insights: [],
    tokenUsage: emptyTokenUsage(),
    phaseUsage: [],
    createdAt: '2026-04-04T00:00:00Z',
    updatedAt: '2026-04-04T00:00:00Z',
    ...overrides,
  }
}

interface MakeCtxOpts {
  job?: Partial<Job>
  routingStrategy?: 'path' | 'agent'
  overlay?: ToolContext['tenantContext']['overlay']
  proposalsStore?: Map<string, Proposal>
}

function makeCtx(opts: MakeCtxOpts = {}): ToolContext {
  const job = makeJob(opts.job)
  const proposalsStore = opts.proposalsStore ?? new Map<string, Proposal>()

  const stateBackend = {
    appendLog: vi.fn().mockResolvedValue(undefined),
    createProposal: vi.fn(async (p: Omit<Proposal, 'id'>) => {
      const id = `proposal-${proposalsStore.size + 1}`
      const stored: Proposal = { ...p, id }
      proposalsStore.set(id, stored)
      return stored
    }),
    listProposals: vi.fn(async (tenantId: string, status?: Proposal['status']) => {
      let arr = Array.from(proposalsStore.values()).filter(p => p.tenantId === tenantId)
      if (status) arr = arr.filter(p => p.status === status)
      return arr
    }),
  } as unknown as ToolContext['stateBackend']

  return {
    job,
    stateBackend,
    settings: {
      paths: { workingDir: '/tmp/working', coroIntelligenceDir: '/tmp/coro/intel' },
      proposals: { routing: { strategy: opts.routingStrategy ?? 'path' } },
    } as unknown as ToolContext['settings'],
    tenantContext: {
      tenantId: 'team-acme',
      mode: 'team' as const,
      displayName: 'Team ACME',
      overlay: opts.overlay ?? { kind: 'gitRemote', url: 'git@github.com:acme/intel.git', ref: 'main' },
    },
    jobIntelligenceDir: '/tmp/working/job-1/_intelligence',
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as ToolContext['logger'],
    gitClient: {} as ToolContext['gitClient'],
    bbCoder: {} as ToolContext['bbCoder'],
    bbReviewer: {} as ToolContext['bbReviewer'],
    ghClient: {} as unknown as ToolContext['ghClient'],
    ghGitClient: null,
    lokiClient: {} as ToolContext['lokiClient'],
    tempoClient: {} as ToolContext['tempoClient'],
    jiraClient: {} as ToolContext['jiraClient'],
    trackerClient: {} as ToolContext['trackerClient'],
    runningServices: new Map(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── routeFile ────────────────────────────────────────────────────────────────

describe('routeFile', () => {
  describe('path strategy', () => {
    it('routes .coro/ paths to the repo layer', () => {
      expect(routeFile('.coro/agents/coder.md', 'path', undefined)).toBe('repo')
      expect(routeFile('.coro/memory/notes.md', 'path', undefined)).toBe('repo')
    })

    it('routes everything else to the tenant layer', () => {
      expect(routeFile('agents/coder.md', 'path', undefined)).toBe('tenant')
      expect(routeFile('memory/known-pitfalls.md', 'path', undefined)).toBe('tenant')
      expect(routeFile('workflows/job/workflow.md', 'path', undefined)).toBe('tenant')
      expect(routeFile('.claude/CLAUDE.md', 'path', undefined)).toBe('tenant')
      expect(routeFile('.claude/skills/foo/SKILL.md', 'path', undefined)).toBe('tenant')
    })

    it('rejects paths outside the writable allowlist', () => {
      expect(() => routeFile('src/index.ts', 'path', undefined)).toThrow('not in the writable allowlist')
      expect(() => routeFile('package.json', 'path', undefined)).toThrow('not in the writable allowlist')
    })

    it('rejects path traversal', () => {
      expect(() => routeFile('../etc/passwd', 'path', undefined)).toThrow('must be relative')
      expect(() => routeFile('agents/../../../etc/passwd', 'path', undefined)).toThrow('must be relative')
    })

    it('rejects absolute paths', () => {
      expect(() => routeFile('/etc/passwd', 'path', undefined)).toThrow('must be relative')
    })

    it('throws when explicit targetLayer disagrees with the path', () => {
      expect(() => routeFile('agents/coder.md', 'path', 'repo')).toThrow('Layer mismatch')
      expect(() => routeFile('.coro/agents/coder.md', 'path', 'tenant')).toThrow('Layer mismatch')
    })

    it('accepts an explicit targetLayer when it agrees with the path', () => {
      expect(routeFile('agents/coder.md', 'path', 'tenant')).toBe('tenant')
      expect(routeFile('.coro/agents/coder.md', 'path', 'repo')).toBe('repo')
    })
  })

  describe('agent strategy', () => {
    it('requires an explicit targetLayer', () => {
      expect(() => routeFile('agents/coder.md', 'agent', undefined)).toThrow('requires an explicit targetLayer')
    })

    it('still validates path/layer consistency', () => {
      expect(() => routeFile('agents/coder.md', 'agent', 'repo')).toThrow('Layer mismatch')
    })

    it('accepts a consistent explicit targetLayer', () => {
      expect(routeFile('agents/coder.md', 'agent', 'tenant')).toBe('tenant')
    })
  })
})

// ── validateProposalFiles ────────────────────────────────────────────────────

describe('validateProposalFiles', () => {
  it('rejects empty file lists', () => {
    expect(() => validateProposalFiles('memory-update', [])).toThrow('at least one file')
  })

  it('rejects empty file content', () => {
    expect(() =>
      validateProposalFiles('memory-update', [{ path: 'memory/x.md', content: '   ' }]),
    ).toThrow('empty content')
  })

  it('requires skill files under .claude/skills/', () => {
    expect(() =>
      validateProposalFiles('skill-create', [
        { path: 'agents/skill.md', content: 'x' },
      ]),
    ).toThrow('Skill files must live under')
  })

  it('requires SKILL.md to have YAML frontmatter with name + description', () => {
    expect(() =>
      validateProposalFiles('skill-create', [
        { path: '.claude/skills/foo/SKILL.md', content: '# no frontmatter' },
      ]),
    ).toThrow('YAML frontmatter')

    expect(() =>
      validateProposalFiles('skill-create', [
        { path: '.claude/skills/foo/SKILL.md', content: '---\nname: \n---\n# x' },
      ]),
    ).toThrow('non-empty "name"')

    expect(() =>
      validateProposalFiles('skill-create', [
        { path: '.claude/skills/foo/SKILL.md', content: '---\nname: foo\n---\n# x' },
      ]),
    ).toThrow('non-empty "description"')

    // Valid frontmatter passes.
    expect(() =>
      validateProposalFiles('skill-create', [
        {
          path: '.claude/skills/foo/SKILL.md',
          content: '---\nname: foo\ndescription: a useful skill\n---\n# Foo skill\n',
        },
      ]),
    ).not.toThrow()
  })

  it('restricts claude-md-update to CLAUDE.md', () => {
    expect(() =>
      validateProposalFiles('claude-md-update', [
        { path: 'agents/coder.md', content: '# Coder' },
      ]),
    ).toThrow('claude-md-update proposals may only touch')
  })

  it('requires agent files to live under agents/', () => {
    expect(() =>
      validateProposalFiles('modify-agent', [
        { path: 'memory/coder.md', content: '# Coder' },
      ]),
    ).toThrow('must live under agents/')
  })

  it('requires agent files to start with a heading', () => {
    expect(() =>
      validateProposalFiles('modify-agent', [
        { path: 'agents/coder.md', content: 'no heading' },
      ]),
    ).toThrow('top-level heading')
  })
})

// ── proposeChange ────────────────────────────────────────────────────────────

describe('proposeChange', () => {
  it('ships a single multi-file tenant proposal end-to-end', async () => {
    const ctx = makeCtx()
    const result = await proposeChange(
      {
        type: 'memory-update',
        title: 'Add API quirk pitfall',
        rationale: 'We hit this twice in two days.',
        description: 'Append to known-pitfalls.md',
        files: [
          { path: 'memory/known-pitfalls.md', content: '## Pitfall: rate limit only on Tuesdays' },
        ],
      },
      ctx,
    )

    expect(result.targetLayer).toBe('tenant')
    expect(result.branch).toMatch(/^coro\/proposal\/job-1-tenant-add-api-quirk-pitfall$/)
    expect(result.prUrl).toBe('https://github.com/acme/intel/pull/17')
    expect(result.prId).toBe(17)

    expect(writerMock.prepareTenantWriter).toHaveBeenCalledWith(expect.objectContaining({
      url: 'git@github.com:acme/intel.git',
      tenantId: 'team-acme',
    }))
    expect(writerMock.commitAndPush).toHaveBeenCalledWith(expect.objectContaining({
      branch: result.branch,
      baseRef: 'main',
      files: expect.arrayContaining([
        expect.objectContaining({ path: 'memory/known-pitfalls.md' }),
      ]),
    }))
    expect(writerMock.openProposalPr).toHaveBeenCalledWith(expect.objectContaining({
      remoteUrl: 'git@github.com:acme/intel.git',
      branch: result.branch,
      title: 'Coro proposal: Add API quirk pitfall',
    }))

    expect(ctx.stateBackend.createProposal).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'team-acme',
      jobId: 'job-1',
      type: 'memory-update',
      targetLayer: 'tenant',
      branch: result.branch,
      prUrl: 'https://github.com/acme/intel/pull/17',
      prId: 17,
      status: 'pending',
    }))

    expect(ctx.stateBackend.appendLog).toHaveBeenCalledWith(
      'job-1',
      expect.stringContaining('[propose_change]'),
    )
  })

  it('routes a .coro/ path to the repo layer and uses the repo writer', async () => {
    const ctx = makeCtx()
    const result = await proposeChange(
      {
        type: 'memory-update',
        title: 'Project-only quirk',
        rationale: 'r',
        description: 'd',
        files: [{ path: '.coro/memory/notes.md', content: '## quirk' }],
      },
      ctx,
    )

    expect(result.targetLayer).toBe('repo')
    expect(writerMock.prepareRepoWriter).toHaveBeenCalled()
    expect(writerMock.prepareTenantWriter).not.toHaveBeenCalled()
  })

  it('throws when tenant overlay is not configured but a tenant proposal is filed', async () => {
    const ctx = makeCtx({ overlay: { kind: 'none' } })
    await expect(
      proposeChange(
        {
          type: 'memory-update',
          title: 't',
          rationale: 'r',
          description: 'd',
          files: [{ path: 'memory/x.md', content: 'y' }],
        },
        ctx,
      ),
    ).rejects.toThrow(/tenant overlay must be a git remote/)
  })

  it('throws when the job has no repoSlug but a repo proposal is filed', async () => {
    const ctx = makeCtx({ job: { params: {} } })
    await expect(
      proposeChange(
        {
          type: 'memory-update',
          title: 't',
          rationale: 'r',
          description: 'd',
          files: [{ path: '.coro/memory/x.md', content: 'y' }],
        },
        ctx,
      ),
    ).rejects.toThrow('the active job has no repoSlug')
  })

  it('rejects mixed layers in one call', async () => {
    const ctx = makeCtx()
    await expect(
      proposeChange(
        {
          type: 'memory-update',
          title: 'mixed',
          rationale: 'r',
          description: 'd',
          files: [
            { path: 'memory/tenant-note.md', content: 'a' },
            { path: '.coro/memory/repo-note.md', content: 'b' },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow('All files in a single propose_change call must target the same layer')
  })

  it('records the proposal AFTER the PR is opened (not before)', async () => {
    const ctx = makeCtx()
    // Make commitAndPush throw — createProposal should not be called.
    vi.mocked(writerMock.commitAndPush).mockRejectedValueOnce(new Error('git push failed'))

    await expect(
      proposeChange(
        {
          type: 'memory-update',
          title: 't',
          rationale: 'r',
          description: 'd',
          files: [{ path: 'memory/x.md', content: 'y' }],
        },
        ctx,
      ),
    ).rejects.toThrow('git push failed')

    expect(ctx.stateBackend.createProposal).not.toHaveBeenCalled()
  })

  it('normalises legacy targetFile + proposedContent into the files array', async () => {
    const ctx = makeCtx()
    await proposeChange(
      {
        type: 'memory-update',
        title: 'Legacy shim',
        rationale: 'r',
        description: 'd',
        targetFile: 'memory/legacy.md',
        proposedContent: '## legacy',
      },
      ctx,
    )

    expect(writerMock.commitAndPush).toHaveBeenCalledWith(expect.objectContaining({
      files: expect.arrayContaining([
        expect.objectContaining({ path: 'memory/legacy.md', content: '## legacy' }),
      ]),
    }))
  })
})

// ── listProposals ────────────────────────────────────────────────────────────

describe('listProposals', () => {
  it('returns proposals for the tenant from the state backend', async () => {
    const store = new Map<string, Proposal>()
    const ctx = makeCtx({ proposalsStore: store })

    // Seed two proposals; same-tenant only should be visible.
    store.set('a', { id: 'a', tenantId: 'team-acme', jobId: 'j', type: 'memory-update', title: 'A', rationale: 'r', description: 'd', status: 'pending', files: [], createdAt: 't', updatedAt: 't' })
    store.set('b', { id: 'b', tenantId: 'other', jobId: 'j', type: 'memory-update', title: 'B', rationale: 'r', description: 'd', status: 'pending', files: [], createdAt: 't', updatedAt: 't' })

    const result = await listProposals({}, ctx)
    expect(result.count).toBe(1)
    expect(result.proposals[0].id).toBe('a')
  })

  it('respects the limit parameter', async () => {
    const store = new Map<string, Proposal>()
    for (let i = 0; i < 5; i++) {
      store.set(String(i), {
        id: String(i), tenantId: 'team-acme', jobId: 'j', type: 'memory-update',
        title: `t${i}`, rationale: 'r', description: 'd', status: 'pending', files: [],
        createdAt: 't', updatedAt: 't',
      })
    }
    const ctx = makeCtx({ proposalsStore: store })
    const result = await listProposals({ limit: 2 }, ctx)
    expect(result.count).toBe(2)
    expect(result.totalForTenant).toBe(5)
  })

  it('filters by type', async () => {
    const store = new Map<string, Proposal>()
    store.set('a', { id: 'a', tenantId: 'team-acme', jobId: 'j', type: 'memory-update', title: 'A', rationale: 'r', description: 'd', status: 'pending', files: [], createdAt: 't', updatedAt: 't' })
    store.set('b', { id: 'b', tenantId: 'team-acme', jobId: 'j', type: 'modify-agent', title: 'B', rationale: 'r', description: 'd', status: 'pending', files: [], createdAt: 't', updatedAt: 't' })

    const ctx = makeCtx({ proposalsStore: store })
    const result = await listProposals({ type: 'modify-agent' }, ctx)
    expect(result.count).toBe(1)
    expect(result.proposals[0].id).toBe('b')
  })

  it('truncates long rationale into a preview', async () => {
    const store = new Map<string, Proposal>()
    const longRationale = 'x'.repeat(1000)
    store.set('a', {
      id: 'a', tenantId: 'team-acme', jobId: 'j', type: 'memory-update',
      title: 'A', rationale: longRationale, description: 'd', status: 'pending', files: [],
      createdAt: 't', updatedAt: 't',
    })
    const ctx = makeCtx({ proposalsStore: store })
    const result = await listProposals({}, ctx)
    expect(result.proposals[0].rationalePreview.length).toBeLessThan(longRationale.length)
    expect(result.proposals[0].rationalePreview.endsWith('…')).toBe(true)
  })
})
