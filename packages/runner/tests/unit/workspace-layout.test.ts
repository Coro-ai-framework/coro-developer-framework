import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { simpleGit } from 'simple-git'
import {
  buildPrimaryRepoCandidates,
  buildWorkspaceLayoutPromptBlock,
  resolveJobWorkspaceLayout,
  resolvePrimaryRepoCheckout,
} from '../../src/jobs/workspace-layout'
import { JobType, type Job } from '@coro-ai/cloud-protocol'
import { emptyTokenUsage } from '../../src/jobs/helpers'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'ws-job',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: { repoSlug: 'svc' },
    triggerSource: 'cli',
    status: 'running',
    phase: 'coding',
    currentWorkItem: null,
    workItems: [],
    workItemLoopCount: 0,
    prMappings: [],
    interactive: false,
    artifacts: [],
    insights: [],
    tokenUsage: emptyTokenUsage(),
    phaseUsage: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('resolveJobWorkspaceLayout', () => {
  it('prefers persisted checkout params over repoSlug', () => {
    const layout = resolveJobWorkspaceLayout(
      makeJob({
        params: {
          repoSlug: 'old',
          repoCheckoutDir: 'my-repo',
          repoCheckoutAbsDir: '/work/ws-job/my-repo',
        },
      }),
      '/work/ws-job',
    )
    expect(layout.repoCheckoutDir).toBe('my-repo')
    expect(layout.repoCheckoutAbsDir).toBe('/work/ws-job/my-repo')
  })

  it('surfaces campaignContextDir when set on campaign children', () => {
    const layout = resolveJobWorkspaceLayout(
      makeJob({ params: { repoSlug: 'svc', campaignContextDir: 'campaign' } }),
      '/work/ws-job',
    )
    expect(layout.campaignContextDir).toBe('campaign')
    const block = buildWorkspaceLayoutPromptBlock(layout)
    expect(block).toContain('Campaign context: `campaign/`')
  })
})

describe('buildPrimaryRepoCandidates', () => {
  it('prefers targetRepo over persisted source checkout dir', () => {
    const job = makeJob({
      params: {
        sourceRepo: 'know_your_customer',
        targetRepo: 'a5labs.kyc.go',
        repoCheckoutDir: 'know_your_customer',
      },
      prMappings: [{ prId: 1, workItem: 'wi', repoSlug: 'a5labs.kyc.go', openedAt: '2026-01-01' }],
    })
    expect(buildPrimaryRepoCandidates(job)).toEqual([
      'a5labs.kyc.go',
      'know_your_customer',
    ])
  })
})

describe('resolvePrimaryRepoCheckout', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'coro-wsl-'))
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  async function initRepo(dir: string) {
    await fs.mkdir(dir, { recursive: true })
    const git = simpleGit({ baseDir: dir })
    await git.init(['--initial-branch=main'])
    await git.addConfig('user.email', 'test@coro.dev')
    await git.addConfig('user.name', 'Coro Test')
    await git.addConfig('commit.gpgsign', 'false')
    await fs.writeFile(path.join(dir, 'README'), 'x\n')
    await git.add('.')
    await git.commit('init')
  }

  it('picks targetRepo when both source and target exist on disk', async () => {
    const jobDir = path.join(tmp, 'job')
    await initRepo(path.join(jobDir, 'know_your_customer'))
    await initRepo(path.join(jobDir, 'a5labs.kyc.go'))

    const job = makeJob({
      params: {
        sourceRepo: 'know_your_customer',
        targetRepo: 'a5labs.kyc.go',
        repoCheckoutDir: 'know_your_customer',
      },
    })

    const layout = await resolvePrimaryRepoCheckout(job, jobDir)
    expect(layout.repoCheckoutDir).toBe('a5labs.kyc.go')
    expect(layout.repoCheckoutAbsDir).toBe(path.join(jobDir, 'a5labs.kyc.go'))
  })
})

describe('buildWorkspaceLayoutPromptBlock', () => {
  it('is language-agnostic', () => {
    const block = buildWorkspaceLayoutPromptBlock(
      resolveJobWorkspaceLayout(makeJob(), '/work/ws-job'),
    )
    expect(block).toContain('## Workspace layout')
    expect(block).toContain('/work/ws-job/svc')
    expect(block).toContain('{language}-conventions')
    expect(block).not.toMatch(/\bgo build\b/)
    expect(block).not.toMatch(/\bdotnet build\b/)
  })
})
