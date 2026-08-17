import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JobType, type Job } from '@coro-ai/cloud-protocol'

import type { StateBackend } from '../../src/state/backend'
import type { ToolContext } from '../../src/tools/types'
import { makeMockJob, makeMockToolContext } from '../mcp/fixtures'

// The module constructs its own GitHubClient (different owner + token from
// the job's SCM plugin), so the class is stubbed rather than injected.
const gh = {
  searchIssues: vi.fn(),
  createIssue: vi.fn(),
  getIssue: vi.fn(),
  postComment: vi.fn(),
  getRepo: vi.fn(),
  ensureFork: vi.fn(),
  syncFork: vi.fn(),
  createPr: vi.fn(),
}

vi.mock('../../src/clients/github', () => ({
  // Constructor returning the shared stub — the module news up its own
  // client, so this is the only injection point.
  GitHubClient: class {
    constructor() {
      return gh
    }
  },
  GitHubError: class extends Error {},
}))

// Cloning is exercised against a real filesystem in upstream-source.test.ts;
// here only the tool's own decisions matter.
const materialiseUpstreamSource = vi.fn()

vi.mock('../../src/tools/upstream-source', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/tools/upstream-source')>()
  return {
    ...actual,
    materialiseUpstreamSource: (...a: unknown[]) => materialiseUpstreamSource(...a),
  }
})

/** Stands in for `Dispatcher.dispatch`, wired through `ToolContext`. */
const dispatchJob = vi.fn()

const {
  dispatchImprovementJob,
  fingerprintFinding,
  upstreamCheckout,
  upstreamCommentIssue,
  upstreamCreateIssue,
  upstreamSearch,
  UPSTREAM_MARKER_PREFIX,
} = await import('../../src/tools/upstream')

const FINDING = {
  category: 'base-intelligence',
  title: 'Coder loops on Go test scaffolding',
  targetPaths: ['packages/intelligence-base/layer/agents/coder.md'],
}

const UPSTREAM_SETTINGS = {
  repoUrl: 'https://github.com/coro-ai-framework/coro',
  forkOwner: 'contributor',
  token: 'upstream-token',
  maxIssuesPerRun: 2,
  maxCodeJobsPerRun: 1,
}

/**
 * Retrospective job context with the upstream destination configured and
 * both upstream tiers enabled — the happy path. Individual tests narrow
 * it to assert a specific refusal.
 */
function makeCtx(over: {
  job?: Record<string, unknown>
  upstream?: Partial<typeof UPSTREAM_SETTINGS> | undefined
  jobs?: Job[]
  dispatchJob?: ToolContext['dispatchJob'] | null
} = {}): ToolContext {
  const job = makeMockJob({
    id: 'retro-1',
    type: JobType.Retrospective,
    workflowPath: 'workflows/retrospective/workflow.md',
    params: { tiers: { tenant: true, upstreamIntelligence: true, upstreamCode: true } },
    ...over.job,
  }) as unknown as Job

  // Mutable so `updateJob` patches are visible to the next read, which is
  // what makes the per-run cap testable.
  let current = job
  const stateBackend = {
    listJobs: vi.fn().mockResolvedValue(over.jobs ?? [job]),
    getJob: vi.fn().mockImplementation(async () => current),
    updateJob: vi.fn().mockImplementation(async (_id: string, patch: Partial<Job>) => {
      current = { ...current, ...patch }
      return current
    }),
    appendLog: vi.fn().mockResolvedValue(undefined),
  } as unknown as StateBackend

  return makeMockToolContext({
    job,
    stateBackend,
    ...(over.dispatchJob === null ? {} : { dispatchJob: over.dispatchJob ?? dispatchJob }),
    settings: {
      paths: { workingDir: '/tmp/work', coroIntelligenceDir: '/tmp/intel' },
      bitbucket: { workspace: 'acme' },
      github: { owner: 'acme-gh', token: 'scm-token' },
      ...('upstream' in over ? { upstream: over.upstream } : { upstream: UPSTREAM_SETTINGS }),
    } as unknown as ToolContext['settings'],
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  gh.searchIssues.mockResolvedValue([])
  gh.createIssue.mockResolvedValue({
    number: 42, title: 't', url: 'https://github.com/o/r/issues/42',
    state: 'open', isPr: false, body: '', createdAt: '', updatedAt: '',
  })
  gh.getIssue.mockImplementation(async (_slug: string, number: number) => ({
    number, title: 't', url: `https://github.com/o/r/issues/${number}`,
    state: 'open', isPr: false, body: '', createdAt: '', updatedAt: '',
  }))
  gh.postComment.mockResolvedValue({ id: 1, content: { raw: '' }, created_on: '', updated_on: '' })
  gh.getRepo.mockResolvedValue({
    full_name: 'coro-ai-framework/coro', default_branch: 'main',
    clone_url: 'https://github.com/coro-ai-framework/coro.git',
    html_url: 'https://github.com/coro-ai-framework/coro', fork: false,
  })
  materialiseUpstreamSource.mockResolvedValue({
    dir: '_upstream',
    absDir: '/tmp/work/retro-1/_upstream',
    repo: 'coro-ai-framework/coro',
    ref: 'main',
    commit: 'abc123def456',
    at: '2026-08-13T12:00:00.000Z',
    cloned: true,
  })
  gh.ensureFork.mockResolvedValue({
    full_name: 'contributor/coro', default_branch: 'main',
    clone_url: 'https://github.com/contributor/coro.git',
    html_url: '', fork: true,
  })
  gh.syncFork.mockResolvedValue(true)
  dispatchJob.mockResolvedValue({ id: 'coro-child-1' })
})

describe('fingerprintFinding', () => {
  it('is stable across wording noise so two installs converge on one issue', () => {
    const a = fingerprintFinding(FINDING)
    const b = fingerprintFinding({
      ...FINDING,
      title: '  Coder LOOPS on Go test scaffolding!  ',
    })
    expect(b).toBe(a)
  })

  it('ignores the order target paths were listed in', () => {
    const one = fingerprintFinding({ ...FINDING, targetPaths: ['a.md', 'b.md'] })
    const two = fingerprintFinding({ ...FINDING, targetPaths: ['b.md', 'a.md'] })
    expect(two).toBe(one)
  })

  it('separates findings that differ in substance', () => {
    expect(fingerprintFinding({ ...FINDING, category: 'runner-code' }))
      .not.toBe(fingerprintFinding(FINDING))
    expect(fingerprintFinding({ ...FINDING, title: 'Planner under-splits work items' }))
      .not.toBe(fingerprintFinding(FINDING))
  })
})

describe('the upstream gates', () => {
  it('refuses a job that is not a retrospective', async () => {
    const ctx = makeCtx({ job: { type: JobType.Job } })
    await expect(upstreamSearch({ finding: FINDING }, ctx)).rejects.toThrow(
      /only available to retrospective jobs/,
    )
  })

  it('refuses when the install has not configured an upstream destination', async () => {
    const ctx = makeCtx({ upstream: undefined })
    await expect(upstreamSearch({ finding: FINDING }, ctx)).rejects.toThrow(/upstream\.repoUrl/)
  })

  it('refuses when the run was launched without the upstream destination', async () => {
    const ctx = makeCtx({
      job: { params: { tiers: { tenant: true, upstreamIntelligence: false, upstreamCode: false } } },
    })
    await expect(upstreamCreateIssue({ title: 'x', body: 'y', finding: FINDING }, ctx))
      .rejects.toThrow(/destination disabled/)
  })

  it('refuses when no token is available from either the upstream block or the SCM plugin', async () => {
    const ctx = makeCtx({ upstream: { ...UPSTREAM_SETTINGS, token: undefined } })
    ;(ctx.settings as { github: { token?: string } }).github.token = undefined
    await expect(upstreamSearch({ finding: FINDING }, ctx)).rejects.toThrow(/GitHub token/)
  })
})

describe('upstreamCheckout', () => {
  it('snapshots the upstream default branch into the job working directory', async () => {
    const ctx = makeCtx()
    const result = await upstreamCheckout({}, ctx)

    expect(materialiseUpstreamSource).toHaveBeenCalledWith(expect.objectContaining({
      cloneUrl: 'https://github.com/coro-ai-framework/coro.git',
      repo: 'coro-ai-framework/coro',
      // Upstream's branch, not the version that produced the job history —
      // otherwise the analyst re-reports defects already fixed upstream.
      ref: 'main',
      jobWorkingDir: '/tmp/work/retro-1',
    }))
    expect(result).toMatchObject({
      dir: '_upstream',
      commit: 'abc123def456',
      commitUrl: 'https://github.com/coro-ai-framework/coro/tree/abc123def456',
    })
  })

  it('logs the revision once, so a reused snapshot is not announced twice', async () => {
    const ctx = makeCtx()
    await upstreamCheckout({}, ctx)
    expect(ctx.stateBackend.appendLog).toHaveBeenCalledWith('retro-1', expect.stringContaining('abc123de'))

    vi.mocked(ctx.stateBackend.appendLog).mockClear()
    materialiseUpstreamSource.mockResolvedValueOnce({
      dir: '_upstream',
      absDir: '/tmp/work/retro-1/_upstream',
      repo: 'coro-ai-framework/coro',
      ref: 'main',
      commit: 'abc123def456',
      at: '2026-08-13T12:00:00.000Z',
      cloned: false,
    })
    await upstreamCheckout({}, ctx)
    expect(ctx.stateBackend.appendLog).not.toHaveBeenCalled()
  })

  it('is available to a run enabling either contribution destination', async () => {
    const intelligenceOnly = makeCtx({
      job: { params: { tiers: { tenant: true, upstreamIntelligence: true, upstreamCode: false } } },
    })
    await expect(upstreamCheckout({}, intelligenceOnly)).resolves.toBeTruthy()

    const codeOnly = makeCtx({
      job: { params: { tiers: { tenant: true, upstreamIntelligence: false, upstreamCode: true } } },
    })
    await expect(upstreamCheckout({}, codeOnly)).resolves.toBeTruthy()
  })

  it('refuses a tenant-only run, which has nothing to verify for publication', async () => {
    const ctx = makeCtx({
      job: { params: { tiers: { tenant: true, upstreamIntelligence: false, upstreamCode: false } } },
    })
    await expect(upstreamCheckout({}, ctx)).rejects.toThrow(/destination disabled/)
    expect(materialiseUpstreamSource).not.toHaveBeenCalled()
  })
})

describe('upstreamSearch', () => {
  it('searches by marker and reports a duplicate when a hit carries it', async () => {
    const ctx = makeCtx()
    const fingerprint = fingerprintFinding(FINDING)
    gh.searchIssues.mockResolvedValue([
      { number: 9, title: 'known', url: 'u', state: 'open', isPr: false, createdAt: '', updatedAt: '',
        body: `evidence\n\n<!-- ${UPSTREAM_MARKER_PREFIX}${fingerprint} -->` },
    ])

    const result = await upstreamSearch({ finding: FINDING }, ctx)

    expect(gh.searchIssues).toHaveBeenCalledWith(
      'coro-ai-framework/coro',
      `"${UPSTREAM_MARKER_PREFIX}${fingerprint}"`,
      { state: 'open' },
    )
    expect(result).toMatchObject({ duplicate: true, fingerprint, repo: 'coro-ai-framework/coro' })
  })

  it('does not call a marker hit on an unrelated issue a duplicate', async () => {
    const ctx = makeCtx()
    gh.searchIssues.mockResolvedValue([
      { number: 9, title: 'similar words', url: 'u', state: 'open', isPr: false, body: 'no marker', createdAt: '', updatedAt: '' },
    ])
    const result = await upstreamSearch({ finding: FINDING }, ctx)
    expect(result.duplicate).toBe(false)
  })

  it('requires either a finding or a query', async () => {
    await expect(upstreamSearch({}, makeCtx())).rejects.toThrow(/either a `finding` or a `query`/)
  })
})

describe('upstreamCreateIssue', () => {
  const args = {
    title: 'Coder loops on Go test scaffolding',
    body: 'Seen in repo-A across 4 runs; the coding phase ran 5 times each.',
    finding: FINDING,
  }

  it('appends the fingerprint marker and labels the issue', async () => {
    const ctx = makeCtx()
    const result = await upstreamCreateIssue(args, ctx)

    const [repo, payload] = gh.createIssue.mock.calls[0]
    expect(repo).toBe('coro-ai-framework/coro')
    expect(payload.body).toContain(`<!-- ${UPSTREAM_MARKER_PREFIX}${fingerprintFinding(FINDING)} -->`)
    expect(payload.labels).toEqual(['coro-retrospective'])
    expect(result).toMatchObject({ number: 42, issuesOpenedThisRun: 1 })
  })

  it('refuses text that still names the install, without sending anything', async () => {
    const jobs = [makeMockJob({ id: 'job-1', params: { repoSlug: 'billing-api' } }) as unknown as Job]
    const ctx = makeCtx({ jobs })

    await expect(upstreamCreateIssue(
      { ...args, body: 'The billing-api job looped five times.' },
      ctx,
    )).rejects.toThrow(/still contains identifiers/)

    expect(gh.createIssue).not.toHaveBeenCalled()
  })

  it('names the offending section so the agent knows what to rewrite', async () => {
    const jobs = [makeMockJob({ id: 'job-1', params: { repoSlug: 'billing-api' } }) as unknown as Job]
    const ctx = makeCtx({ jobs })
    await expect(upstreamCreateIssue({ ...args, title: 'billing-api loops' }, ctx))
      .rejects.toThrow(/title: repo "billing-api"/)
  })

  it('stops at the configured per-run cap', async () => {
    const ctx = makeCtx()
    await upstreamCreateIssue(args, ctx)
    await upstreamCreateIssue({ ...args, title: 'Second finding' }, ctx)

    await expect(upstreamCreateIssue({ ...args, title: 'Third finding' }, ctx))
      .rejects.toThrow(/configured limit \(2\)/)
    expect(gh.createIssue).toHaveBeenCalledTimes(2)
  })

  it('requires a title and a body', async () => {
    await expect(upstreamCreateIssue({ ...args, title: '  ' }, makeCtx())).rejects.toThrow(/requires a title/)
    await expect(upstreamCreateIssue({ ...args, body: '' }, makeCtx())).rejects.toThrow(/requires a body/)
  })

  it('is available when only the code destination is enabled', async () => {
    const ctx = makeCtx({
      job: { params: { tiers: { tenant: true, upstreamIntelligence: false, upstreamCode: true } } },
    })
    await expect(upstreamCreateIssue(args, ctx)).resolves.toMatchObject({ number: 42 })
  })

  it('refuses a finding it cannot fingerprint rather than hashing partial input', async () => {
    await expect(upstreamCreateIssue(
      { ...args, finding: { category: 'base-intelligence', title: '' } },
      makeCtx(),
    )).rejects.toThrow(/both a category and a title/)
    expect(gh.createIssue).not.toHaveBeenCalled()
  })
})

describe('upstreamCommentIssue', () => {
  it('posts the evidence and returns the issue URL', async () => {
    const ctx = makeCtx()
    const result = await upstreamCommentIssue({ number: 42, body: 'Also seen here, 3 runs.' }, ctx)

    expect(gh.postComment).toHaveBeenCalledWith('coro-ai-framework/coro', 42, 'Also seen here, 3 runs.')
    expect(result).toEqual({ issueNumber: 42, url: 'https://github.com/o/r/issues/42' })
  })

  it('applies the same sanitisation gate as issue creation', async () => {
    const jobs = [makeMockJob({ id: 'job-1', params: { repoSlug: 'billing-api' } }) as unknown as Job]
    await expect(upstreamCommentIssue({ number: 42, body: 'billing-api again' }, makeCtx({ jobs })))
      .rejects.toThrow(/still contains identifiers/)
    expect(gh.postComment).not.toHaveBeenCalled()
  })
})

describe('dispatchImprovementJob', () => {
  const codeItem = {
    findingId: 'finding-3',
    category: 'runner-code',
    issueNumber: 42,
    title: 'Phase retry loses the corrective prompt',
    description: 'The corrective prompt is dropped on retry; see packages/runner/src/jobs/runner.ts.',
  }
  const intelItem = {
    findingId: 'finding-1',
    category: 'base-intelligence',
    issueNumber: 46,
    title: 'Spec writer skips tracker comments',
    description: 'agents/spec-writer.md only calls tracker_get_issue; comments override the body.',
  }
  const args = { items: [codeItem] }

  it('dispatches a child job aimed at upstream from the fork', async () => {
    const ctx = makeCtx()
    const result = await dispatchImprovementJob(args, ctx)

    const input = dispatchJob.mock.calls[0][0]
    expect(input).toMatchObject({
      type: 'job',
      workflowPath: 'workflows/oss-contribution/workflow.md',
      triggerSource: 'internal',
    })
    // The clone target is the fork; the PR target is upstream. Swapping
    // these produces a PR nobody upstream ever sees.
    expect(input.params).toMatchObject({
      repo: 'contributor/coro',
      repoSlug: 'contributor/coro',
      upstreamRepo: 'coro-ai-framework/coro',
      prSourceOwner: 'contributor',
      prTargetBranch: 'main',
      upstreamIssueNumber: 42,
      retrospectiveJobId: 'retro-1',
      retrospectiveFindingId: 'finding-3',
      epicAllowed: false,
      reviewers: [],
    })
    expect(input.params.findings).toEqual([
      expect.objectContaining({
        id: 'finding-3',
        category: 'runner-code',
        issueNumber: 42,
        issueUrl: 'https://github.com/o/r/issues/42',
      }),
    ])
    expect(input.params.description).toContain('finding-3')
    expect(input.params.description).toContain(codeItem.description)

    expect(result).toMatchObject({
      childJobId: 'coro-child-1',
      forkSlug: 'contributor/coro',
      upstreamRepo: 'coro-ai-framework/coro',
      findingIds: ['finding-3'],
      codeJobsDispatchedThisRun: 1,
    })
  })

  it('puts several findings on one child so the planner can keep a coupled story in one PR', async () => {
    const result = await dispatchImprovementJob({ items: [intelItem, codeItem] }, makeCtx())

    expect(dispatchJob).toHaveBeenCalledTimes(1)
    const input = dispatchJob.mock.calls[0][0]
    expect(input.params.title).toBe('Spec writer skips tracker comments (+1 more)')
    expect(input.params.findings).toEqual([
      expect.objectContaining({ id: 'finding-1', issueNumber: 46, issueUrl: 'https://github.com/o/r/issues/46' }),
      expect.objectContaining({ id: 'finding-3', issueNumber: 42, issueUrl: 'https://github.com/o/r/issues/42' }),
    ])
    expect(input.params.description).toContain('finding-1')
    expect(input.params.description).toContain('finding-3')
    expect(result.findingIds).toEqual(['finding-1', 'finding-3'])
    expect(result.issues).toEqual([
      { findingId: 'finding-1', issueNumber: 46, issueUrl: 'https://github.com/o/r/issues/46' },
      { findingId: 'finding-3', issueNumber: 42, issueUrl: 'https://github.com/o/r/issues/42' },
    ])
  })

  it('counts a multi-finding call once against the per-run cap', async () => {
    const ctx = makeCtx()
    await dispatchImprovementJob({ items: [intelItem, codeItem] }, ctx)
    await expect(dispatchImprovementJob(args, ctx)).rejects.toThrow(/configured limit \(1\)/)
    expect(dispatchJob).toHaveBeenCalledTimes(1)
  })

  it('syncs the fork so the child branches from current upstream', async () => {
    await dispatchImprovementJob(args, makeCtx())
    expect(gh.ensureFork).toHaveBeenCalledWith('coro-ai-framework/coro', 'contributor')
    expect(gh.syncFork).toHaveBeenCalledWith('contributor/coro', 'main')
  })

  it('dispatches an intelligence finding when only that destination is enabled', async () => {
    const ctx = makeCtx({
      job: { params: { tiers: { tenant: true, upstreamIntelligence: true, upstreamCode: false } } },
    })
    await expect(dispatchImprovementJob({ items: [intelItem] }, ctx))
      .resolves.toMatchObject({ childJobId: 'coro-child-1' })
    expect(dispatchJob).toHaveBeenCalledTimes(1)
  })

  it('refuses a code item when the run was launched without the code destination', async () => {
    const ctx = makeCtx({
      job: { params: { tiers: { tenant: true, upstreamIntelligence: true, upstreamCode: false } } },
    })
    await expect(dispatchImprovementJob(args, ctx)).rejects.toThrow(/finding-3 \(runner-code\)/)
    expect(dispatchJob).not.toHaveBeenCalled()
  })

  it('tells the agent the issues are still the outcome when no dispatcher exists', async () => {
    const ctx = makeCtx({ dispatchJob: null })
    await expect(dispatchImprovementJob(args, ctx)).rejects.toThrow(/cannot start jobs/)
  })

  it('requires items the child can act on', async () => {
    await expect(dispatchImprovementJob({ items: [] }, makeCtx()))
      .rejects.toThrow(/requires `items`/)
    await expect(dispatchImprovementJob({ items: [{ ...codeItem, issueNumber: 0 }] }, makeCtx()))
      .rejects.toThrow(/requires the `issueNumber`/)
    await expect(dispatchImprovementJob({ items: [{ ...codeItem, description: '' }] }, makeCtx()))
      .rejects.toThrow(/requires a description/)
    await expect(dispatchImprovementJob({ items: [{ ...codeItem, findingId: '' }] }, makeCtx()))
      .rejects.toThrow(/requires `findingId`/)
    await expect(dispatchImprovementJob({ items: [{ ...codeItem, category: 'tenant-intelligence' }] }, makeCtx()))
      .rejects.toThrow(/tenant findings go through/)
    await expect(dispatchImprovementJob({ items: [codeItem, { ...intelItem, findingId: 'finding-3' }] }, makeCtx()))
      .rejects.toThrow(/more than once/)
    expect(dispatchJob).not.toHaveBeenCalled()
  })

  it('refuses an evidence pack that names this install, before dispatching', async () => {
    const jobs = [makeMockJob({ id: 'job-1', params: { repoSlug: 'billing-api' } }) as unknown as Job]
    await expect(dispatchImprovementJob(
      {
        items: [{
          ...codeItem,
          briefing: {
            behaviourNow: 'now',
            behaviourWanted: 'wanted',
            evidence: 'two jobs',
            targetPaths: ['packages/runner/src/jobs/runner.ts'],
            verified: true,
            failingTest: 'tests/runner/runner.test.ts',
          },
          evidencePack: { grepHits: ['reproduced on billing-api'] },
        }],
      },
      makeCtx({ jobs }),
    )).rejects.toThrow(/still contains identifiers/)
    expect(dispatchJob).not.toHaveBeenCalled()
  })

  it('refuses a briefing that names this install, before dispatching', async () => {
    const jobs = [makeMockJob({ id: 'job-1', params: { repoSlug: 'billing-api' } }) as unknown as Job]
    await expect(dispatchImprovementJob(
      { items: [{ ...codeItem, description: 'Reproduced on billing-api.' }] },
      makeCtx({ jobs }),
    )).rejects.toThrow(/still contains identifiers/)
    expect(dispatchJob).not.toHaveBeenCalled()
  })

  it('accepts a structured briefing without a free-text description', async () => {
    await dispatchImprovementJob({
      items: [{
        findingId: codeItem.findingId,
        category: codeItem.category,
        issueNumber: codeItem.issueNumber,
        title: codeItem.title,
        briefing: {
          behaviourNow: 'Retry drops the corrective prompt.',
          behaviourWanted: 'Retry reapplies the last developer message.',
          evidence: 'reworkRuns 4 on two jobs',
          targetPaths: ['packages/runner/src/jobs/runner.ts'],
          verified: true,
          failingTest: 'tests/runner/runner.test.ts',
        },
      }],
    }, makeCtx())
    const input = dispatchJob.mock.calls[0][0]
    expect(input.params.interactive).toBe(true)
    expect(input.params.findings[0].briefing.failingTest).toBe('tests/runner/runner.test.ts')
    expect(input.params.description).toContain('Failing test:')
  })

  it('refuses a runner-code briefing with no failing test', async () => {
    await expect(dispatchImprovementJob({
      items: [{
        ...codeItem,
        briefing: {
          behaviourNow: 'now',
          behaviourWanted: 'wanted',
          evidence: 'two jobs',
          targetPaths: ['packages/runner/src/jobs/runner.ts'],
          verified: true,
        },
      }],
    }, makeCtx())).rejects.toThrow(/failingTest/)
    expect(dispatchJob).not.toHaveBeenCalled()
  })

  it('refuses a base-intelligence briefing with no neighbouring wording', async () => {
    await expect(dispatchImprovementJob({
      items: [{
        ...intelItem,
        briefing: {
          behaviourNow: 'now',
          behaviourWanted: 'wanted',
          evidence: 'two jobs',
          targetPaths: ['packages/intelligence-base/layer/agents/coder.md'],
          verified: true,
        },
      }],
    }, makeCtx())).rejects.toThrow(/neighbouringWording/)
    expect(dispatchJob).not.toHaveBeenCalled()
  })

  it('stops at the configured per-run cap', async () => {
    const ctx = makeCtx()
    await dispatchImprovementJob(args, ctx)
    await expect(dispatchImprovementJob({ items: [{ ...codeItem, findingId: 'finding-4' }] }, ctx))
      .rejects.toThrow(/configured limit \(1\)/)
    expect(dispatchJob).toHaveBeenCalledTimes(1)
  })
})
