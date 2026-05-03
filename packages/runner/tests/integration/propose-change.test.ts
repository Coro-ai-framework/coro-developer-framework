// ── propose_change end-to-end integration test ──────────────────────────────
//
// Exercises the full self-improvement loop with as little mocking as
// possible:
//
//   - Real `proposeChange()` (no stubs)
//   - Real writer module, doing real clones / branches / commits / pushes
//     against a bare git repo on disk (simulating the tenant remote)
//   - Real SqliteStateBackend persisting the resulting Proposal record
//   - Only the PR client is mocked — `bbCoder.createPr` returns a fake
//     PR URL so we don't hit a live git provider
//
// What we verify:
//   1. The branch is created with the expected `coro/proposal/...` name
//   2. The commit lands on the bare remote with the proposed file content
//   3. The Proposal row in SQLite has the right shape (prUrl, branch,
//      targetLayer, files, status='pending')
//   4. listProposals() finds the new record afterwards

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simpleGit } from 'simple-git'

import { proposeChange, listProposals } from '../../src/tools/self-improvement'
import { SqliteStateBackend } from '../../src/state/sqlite-backend'
import { JobType, emptyTokenUsage, type Job } from '../../src/jobs/types'
import type { ToolContext } from '../../src/tools/types'
import * as writerMock from '../../src/intelligence/writer'

// We mock only `openProposalPr` so the writer can use our local `file://`
// bare repo without needing a real GitHub host. The rest of the writer
// module — including the real simple-git path — runs untouched.
vi.mock('../../src/intelligence/writer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/intelligence/writer')>()
  return {
    ...actual,
    openProposalPr: vi.fn(async (args) => ({
      id: 1234,
      url: `https://example.test/pr/1234?branch=${encodeURIComponent(args.branch)}`,
      provider: 'github' as const,
    })),
  }
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'integration-job-1',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: { repoSlug: 'integration-svc' },
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
    createdAt: '2026-04-30T00:00:00Z',
    updatedAt: '2026-04-30T00:00:00Z',
    ...overrides,
  }
}

let root: string
let bareRemoteDir: string
let writerCacheRoot: string
let stateBackend: SqliteStateBackend

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'coro-integ-'))
  bareRemoteDir = path.join(root, 'tenant-remote.git')
  writerCacheRoot = path.join(root, 'cache', 'writers')
  process.env.HOME = root // so defaultWriterCacheRoot() points inside our temp

  // Initialise a bare git repo to act as the tenant remote.
  await fs.mkdir(bareRemoteDir, { recursive: true })
  await simpleGit(bareRemoteDir).init(true)

  // Seed the bare remote with an initial commit on `main` by cloning
  // it, adding a placeholder file, and pushing.
  const seedDir = path.join(root, 'seed')
  await simpleGit(root).clone(bareRemoteDir, 'seed')
  const seedGit = simpleGit(seedDir)
  await seedGit.addConfig('user.email', 'integration@coro.test', false, 'local')
  await seedGit.addConfig('user.name', 'Coro Integration', false, 'local')
  await fs.writeFile(path.join(seedDir, 'README.md'), '# Tenant intelligence\n')
  await seedGit.add('.')
  await seedGit.commit('init')
  // Force the branch to be `main` (some git installs default to `master`).
  await seedGit.raw(['branch', '-M', 'main'])
  await seedGit.push('origin', 'main', ['--set-upstream'])

  // Configure git identity inside the writer's parent dir too — when
  // `prepareTenantWriter` clones it'll need an identity to commit.
  // We rely on `core.askpass=` + GIT_TERMINAL_PROMPT=0 to fail fast on
  // missing creds rather than hanging. Identity is set by the writer
  // module's clone path picking up our local config; to be safe we set
  // a global env-level identity for the whole test run.
  process.env.GIT_AUTHOR_NAME = 'Coro Test'
  process.env.GIT_AUTHOR_EMAIL = 'test@coro.test'
  process.env.GIT_COMMITTER_NAME = 'Coro Test'
  process.env.GIT_COMMITTER_EMAIL = 'test@coro.test'

  stateBackend = new SqliteStateBackend(path.join(root, 'state.db'))
  await stateBackend.initialize()

  // Pre-seed the jobs table so `appendLog` doesn't trip the FK
  // constraint. We bypass `createJob` to avoid pulling in workflow
  // loading; the test only needs the row to exist.
  const seedJob = makeJob()
  ;(stateBackend as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db
    .prepare('INSERT INTO jobs (id, data, type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(seedJob.id, JSON.stringify(seedJob), seedJob.type, seedJob.status, seedJob.createdAt, seedJob.updatedAt)
})

afterEach(async () => {
  stateBackend.close?.()
  await fs.rm(root, { recursive: true, force: true })
  delete process.env.GIT_AUTHOR_NAME
  delete process.env.GIT_AUTHOR_EMAIL
  delete process.env.GIT_COMMITTER_NAME
  delete process.env.GIT_COMMITTER_EMAIL
  vi.clearAllMocks()
})

function makeCtx(): ToolContext {
  return {
    job: makeJob(),
    stateBackend: stateBackend as unknown as ToolContext['stateBackend'],
    settings: {
      paths: { workingDir: path.join(root, 'working'), coroIntelligenceDir: path.join(root, 'intel') },
      proposals: { routing: { strategy: 'path' } },
    } as unknown as ToolContext['settings'],
    tenantContext: {
      tenantId: 'team-integration',
      mode: 'team' as const,
      displayName: 'Integration tenant',
      overlay: { kind: 'gitRemote', url: bareRemoteDir, ref: 'main' },
    },
    jobIntelligenceDir: path.join(root, 'intel'),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as ToolContext['logger'],
    gitClient: {} as ToolContext['gitClient'],
    bbCoder: {} as ToolContext['bbCoder'],
    bbReviewer: {} as ToolContext['bbReviewer'],
    ghClient: null,
    ghGitClient: null,
    lokiClient: {} as ToolContext['lokiClient'],
    tempoClient: {} as ToolContext['tempoClient'],
    jiraClient: {} as ToolContext['jiraClient'],
    trackerClient: {} as ToolContext['trackerClient'],
    runningServices: new Map(),
  }
}

// ── Test ─────────────────────────────────────────────────────────────────────

describe('propose_change end-to-end', () => {
  it('clones tenant remote, branches, commits, pushes, opens PR, records proposal', async () => {
    // sanity: we'll be using the default writer cache root which is
    // ~/.coro/cache/writers. We override HOME to a temp dir so this
    // test doesn't touch the developer's real ~/.coro.
    void writerCacheRoot

    const ctx = makeCtx()

    const result = await proposeChange(
      {
        type: 'memory-update',
        title: 'Integration test pitfall',
        rationale: 'We tripped on an integration-test gotcha twice running this suite.',
        description: 'Append to known-pitfalls.md.',
        files: [
          { path: 'memory/known-pitfalls.md', content: '## Integration test gotcha\nDo this, not that.\n' },
          { path: 'memory/MEMORY.md', content: '# Memory\n- See [pitfalls](known-pitfalls.md)\n' },
        ],
      },
      ctx,
    )

    // 1) The tool returned a structured success.
    expect(result.targetLayer).toBe('tenant')
    expect(result.branch).toMatch(/^coro\/proposal\/integration-job-1-tenant-integration-test-pitfall$/)
    expect(result.prUrl).toContain('https://example.test/pr/1234')
    expect(result.filesShipped).toEqual(['memory/known-pitfalls.md', 'memory/MEMORY.md'])

    // 2) The mocked PR client was called with the expected arguments.
    expect(writerMock.openProposalPr).toHaveBeenCalledTimes(1)
    const prCall = (writerMock.openProposalPr as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(prCall).toMatchObject({
      branch: result.branch,
      baseRef: 'main',
      title: 'Coro proposal: Integration test pitfall',
      remoteUrl: bareRemoteDir,
    })
    expect(prCall.body).toContain('integration-job-1')
    expect(prCall.body).toContain('memory/known-pitfalls.md')

    // 3) The branch and commit actually landed on the bare remote.
    const verifyDir = path.join(root, 'verify')
    await simpleGit(root).clone(bareRemoteDir, 'verify')
    const verifyGit = simpleGit(verifyDir)
    await verifyGit.fetch('origin', result.branch)
    await verifyGit.checkout(result.branch)

    const pitfall = await fs.readFile(path.join(verifyDir, 'memory/known-pitfalls.md'), 'utf-8')
    expect(pitfall).toContain('Integration test gotcha')
    const memoryIndex = await fs.readFile(path.join(verifyDir, 'memory/MEMORY.md'), 'utf-8')
    expect(memoryIndex).toContain('See [pitfalls](known-pitfalls.md)')

    const log = await verifyGit.log({ maxCount: 1 })
    expect(log.latest?.message).toContain('Coro proposal (tenant): Integration test pitfall')

    // 4) The state backend has the new Proposal row, queryable by tenant.
    const stored = await stateBackend.getProposal('team-integration', result.proposalId)
    expect(stored).not.toBeNull()
    expect(stored).toMatchObject({
      tenantId: 'team-integration',
      jobId: 'integration-job-1',
      type: 'memory-update',
      title: 'Integration test pitfall',
      status: 'pending',
      targetLayer: 'tenant',
      branch: result.branch,
      prUrl: result.prUrl,
      prId: 1234,
    })
    expect(stored?.files).toHaveLength(2)

    // 5) listProposals surfaces the new record.
    const list = await listProposals({ status: 'pending' }, ctx)
    expect(list.count).toBe(1)
    expect(list.proposals[0].id).toBe(result.proposalId)
    expect(list.proposals[0].prUrl).toBe(result.prUrl)
    expect(list.proposals[0].targetLayer).toBe('tenant')
  }, 30000) // git operations on disk can take a moment in CI
})
