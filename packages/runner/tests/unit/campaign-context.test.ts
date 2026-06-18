import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Job } from '@coro-ai/cloud-protocol'
import {
  CAMPAIGN_CONTEXT_DIR,
  materializeCampaignContext,
  prepareCampaignChildParams,
  resolveParentJobRelativePath,
  syncCampaignContextToParent,
} from '../../src/jobs/campaign-context'
import { emptyTokenUsage } from '../../src/jobs/helpers'

function makeParentJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'campaign-parent',
    type: 'job',
    workflowPath: 'workflows/campaign/workflow.md',
    params: { repoSlug: 'my-service' },
    triggerSource: 'cli',
    status: 'awaiting-children',
    phase: 'coordinating',
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

describe('campaign context materialisation', () => {
  let tmp: string
  let parentDir: string
  let childDir: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'coro-campaign-ctx-'))
    parentDir = path.join(tmp, 'campaign-parent')
    childDir = path.join(tmp, 'child-1')
    await fs.mkdir(parentDir, { recursive: true })
    await fs.mkdir(childDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('copies markdown/json from parent while skipping runtime and repo dirs', async () => {
    await fs.writeFile(path.join(parentDir, 'decisions.md'), '# ADR\n', 'utf8')
    await fs.mkdir(path.join(parentDir, 'contracts'), { recursive: true })
    await fs.writeFile(path.join(parentDir, 'contracts', '_index.json'), '{}', 'utf8')
    await fs.mkdir(path.join(parentDir, 'my-service'), { recursive: true })
    await fs.writeFile(path.join(parentDir, 'my-service', 'README.md'), 'repo', 'utf8')
    await fs.mkdir(path.join(parentDir, '_intelligence'), { recursive: true })
    await fs.writeFile(path.join(parentDir, '_intelligence', 'x.md'), 'skip', 'utf8')
    await fs.writeFile(path.join(parentDir, 'notes.txt'), 'skip', 'utf8')

    const { copied } = await materializeCampaignContext({
      parentJob: makeParentJob(),
      parentWorkingDir: parentDir,
      childWorkingDir: childDir,
    })

    expect(copied.sort()).toEqual(['contracts/_index.json', 'decisions.md'])
    await expect(fs.readFile(path.join(childDir, CAMPAIGN_CONTEXT_DIR, 'decisions.md'), 'utf8'))
      .resolves.toBe('# ADR\n')
    await expect(fs.access(path.join(childDir, CAMPAIGN_CONTEXT_DIR, 'my-service', 'README.md')))
      .rejects.toThrow()
  })

  it('syncs child campaign folder back to parent preserving paths', async () => {
    const campaignDir = path.join(childDir, CAMPAIGN_CONTEXT_DIR, 'contracts')
    await fs.mkdir(campaignDir, { recursive: true })
    await fs.writeFile(path.join(campaignDir, 'producer-a.json'), '{"ok":true}', 'utf8')

    const { synced } = await syncCampaignContextToParent({
      childWorkingDir: childDir,
      parentWorkingDir: parentDir,
    })

    expect(synced).toEqual(['contracts/producer-a.json'])
    await expect(fs.readFile(path.join(parentDir, 'contracts', 'producer-a.json'), 'utf8'))
      .resolves.toBe('{"ok":true}')
  })

  it('rewrites parent path params to campaignContextDir without hardcoded names', async () => {
    await fs.writeFile(path.join(parentDir, 'custom-arch.md'), '#', 'utf8')

    const params = await prepareCampaignChildParams({
      params: {
        campaignDecisionsRef: 'working/campaign-parent/custom-arch.md',
        lane: 'standard',
      },
      parentWorkingDir: parentDir,
      parentJobId: 'campaign-parent',
      copiedRelativePaths: ['custom-arch.md'],
    })

    expect(params.campaignContextDir).toBe(CAMPAIGN_CONTEXT_DIR)
    expect(params.campaignDecisionsRef).toBe(`${CAMPAIGN_CONTEXT_DIR}/custom-arch.md`)
    expect(params.lane).toBe('standard')
  })
})

describe('resolveParentJobRelativePath', () => {
  const parentDir = '/working/campaign-parent'

  it('normalises working/{parentId}/ doc shorthand', () => {
    expect(resolveParentJobRelativePath(
      'working/campaign-parent/foo/bar.md',
      parentDir,
      'campaign-parent',
    )).toBe(path.join('foo', 'bar.md'))
  })

  it('returns null for non-path strings', () => {
    expect(resolveParentJobRelativePath('standard', parentDir, 'campaign-parent')).toBeNull()
  })
})
