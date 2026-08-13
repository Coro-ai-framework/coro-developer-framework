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

const writer = {
  prepareUpstreamWriter: vi.fn(),
  commitAndPush: vi.fn(),
}

vi.mock('../../src/intelligence/writer', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/intelligence/writer')>()
  return {
    ...actual,
    prepareUpstreamWriter: (...args: unknown[]) => writer.prepareUpstreamWriter(...args),
    commitAndPush: (...args: unknown[]) => writer.commitAndPush(...args),
  }
})

const {
  fingerprintFinding,
  normalizeUpstreamFiles,
  upstreamCommentIssue,
  upstreamCreateIssue,
  upstreamOpenIntelligencePr,
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
  gh.getIssue.mockResolvedValue({
    number: 42, title: 't', url: 'https://github.com/o/r/issues/42',
    state: 'open', isPr: false, body: '', createdAt: '', updatedAt: '',
  })
  gh.postComment.mockResolvedValue({ id: 1, content: { raw: '' }, created_on: '', updated_on: '' })
  gh.getRepo.mockResolvedValue({
    full_name: 'coro-ai-framework/coro', default_branch: 'main',
    clone_url: 'https://github.com/coro-ai-framework/coro.git',
    html_url: '', fork: false,
  })
  gh.ensureFork.mockResolvedValue({
    full_name: 'contributor/coro', default_branch: 'main',
    clone_url: 'https://github.com/contributor/coro.git',
    html_url: '', fork: true,
  })
  gh.syncFork.mockResolvedValue(true)
  gh.createPr.mockResolvedValue({ id: 7, links: { html: { href: 'https://github.com/o/r/pull/7' } } })
  writer.prepareUpstreamWriter.mockResolvedValue({
    dir: '/tmp/writers/upstream/contributor-coro',
    baseRef: 'main',
    remoteUrl: 'https://github.com/contributor/coro.git',
  })
  writer.commitAndPush.mockResolvedValue(undefined)
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

describe('normalizeUpstreamFiles', () => {
  const good = 'packages/intelligence-base/layer/agents/coder.md'

  it('accepts base-layer markdown and strips a leading ./', () => {
    expect(normalizeUpstreamFiles([{ path: `./${good}`, content: '# x' }]))
      .toEqual([{ path: good, content: '# x' }])
  })

  it('rejects paths outside the base intelligence layer', () => {
    expect(() => normalizeUpstreamFiles([{ path: 'packages/runner/README.md', content: '# x' }]))
      .toThrow(/not contributable/)
  })

  it('rejects non-markdown and empty files', () => {
    expect(() => normalizeUpstreamFiles([
      { path: 'packages/intelligence-base/layer/src/index.ts', content: 'x' },
    ])).toThrow(/must end with \.md/)
    expect(() => normalizeUpstreamFiles([{ path: good, content: '  ' }])).toThrow(/empty content/)
  })

  it('rejects an empty payload', () => {
    expect(() => normalizeUpstreamFiles([])).toThrow(/at least one file/)
  })
})

describe('upstreamOpenIntelligencePr', () => {
  const args = {
    issueNumber: 42,
    title: 'Tighten the coder test-scaffolding procedure',
    body: 'Adds an explicit stop condition so the phase does not re-enter.',
    branchSlug: 'coder-test-scaffolding',
    files: [{ path: 'packages/intelligence-base/layer/agents/coder.md', content: '# Coder\n' }],
  }

  it('syncs the fork, pushes a coro/retro branch, and opens a cross-repo PR', async () => {
    const ctx = makeCtx()
    const result = await upstreamOpenIntelligencePr(args, ctx)

    expect(gh.ensureFork).toHaveBeenCalledWith('coro-ai-framework/coro', 'contributor')
    expect(gh.syncFork).toHaveBeenCalledWith('contributor/coro', 'main')

    const push = writer.commitAndPush.mock.calls[0][0]
    expect(push.branch).toMatch(/^coro\/retro\/retro-1-coder-test-scaffolding$/)
    expect(push.baseRef).toBe('main')
    expect(push.commitMessage).toContain('Fixes #42')

    expect(gh.createPr).toHaveBeenCalledWith(expect.objectContaining({
      repoSlug: 'coro-ai-framework/coro',
      sourceOwner: 'contributor',
      targetBranch: 'main',
      sourceBranch: push.branch,
    }))
    expect(result).toMatchObject({
      prUrl: 'https://github.com/o/r/pull/7',
      prNumber: 7,
      forkSlug: 'contributor/coro',
      forkInSync: true,
      filesShipped: [args.files[0].path],
    })
  })

  it('reports a fork that could not be fast-forwarded instead of failing', async () => {
    gh.syncFork.mockResolvedValue(false)
    const result = await upstreamOpenIntelligencePr(args, makeCtx())
    expect(result.forkInSync).toBe(false)
    expect(gh.createPr).toHaveBeenCalled()
  })

  it('requires the issue the PR fixes', async () => {
    await expect(upstreamOpenIntelligencePr({ ...args, issueNumber: 0 }, makeCtx()))
      .rejects.toThrow(/requires the `issueNumber`/)
  })

  it('checks file contents for leaks before cloning anything', async () => {
    const jobs = [makeMockJob({ id: 'job-1', params: { repoSlug: 'billing-api' } }) as unknown as Job]
    const ctx = makeCtx({ jobs })

    await expect(upstreamOpenIntelligencePr({
      ...args,
      files: [{ ...args.files[0], content: '# Coder\n\nSee billing-api for an example.\n' }],
    }, ctx)).rejects.toThrow(/still contains identifiers/)

    expect(writer.prepareUpstreamWriter).not.toHaveBeenCalled()
    expect(gh.ensureFork).not.toHaveBeenCalled()
  })
})
