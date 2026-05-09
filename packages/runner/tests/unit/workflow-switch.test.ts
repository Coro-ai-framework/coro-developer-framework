import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { switchWorkflow } from '../../src/tools/workflow-switch'
import { CAMPAIGN_WORKFLOW_PATH, type Job } from '../../src/jobs/types'
import type { PhaseSignals, ToolContext } from '../../src/tools/types'
import { makeMockToolContext, makeMockJob } from '../mcp/fixtures'

/**
 * Build a temp intelligence dir containing the supplied workflow files
 * (path relative → markdown content). The returned dir works as
 * `ctx.jobIntelligenceDir` for the path-existence check.
 */
function withTempIntelligence(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-wf-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  return root
}

const WORKFLOW_JOB_FAST = `---
initial_phase: fast-coding
initial_status: queued
phases:
  - name: fast-coding
    agent: coder
    model: coding
    status: coding
  - name: fast-merge
    agent: pr-reviewer
    model: planning
    status: review
---

# Fast lane workflow
`

const WORKFLOW_CAMPAIGN = `---
initial_phase: campaign-planning
initial_status: queued
phases:
  - name: campaign-planning
    agent: campaign-planner
    model: planning
    status: campaign-planning
  - name: coordinating
    agent: null
    model: planning
    status: awaiting-children
---

# Campaign workflow
`

function setIntelligenceDir(ctx: ToolContext, dir: string): void {
  ;(ctx as { jobIntelligenceDir: string }).jobIntelligenceDir = dir
  ;(ctx.settings as unknown as { paths: Record<string, string> }).paths = {
    ...(ctx.settings.paths as unknown as Record<string, string>),
    coroIntelligenceDir: dir,
    baseLayerDir: dir,
    workingDir: '/tmp/work',
  }
}

describe('switchWorkflow', () => {
  let ctx: ToolContext
  let signals: PhaseSignals
  let tmpDir: string

  beforeEach(() => {
    ctx = makeMockToolContext()
    signals = {}
  })

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('switches workflow, persists history, resets sessionId, signals nextPhase', async () => {
    tmpDir = withTempIntelligence({
      'workflows/job-fast/workflow.md': WORKFLOW_JOB_FAST,
    })
    setIntelligenceDir(ctx, tmpDir)

    // Stub state with a job that has a sessionId so we can verify reset.
    const startingJob = makeMockJob({
      workflowPath: 'workflows/job/workflow.md',
      phase: 'planning',
      sessionId: 'sess-old',
      params: { repoSlug: 'svc' },
    })
    ctx.job = startingJob as Job

    let stored: Job = startingJob as Job
    ctx.stateBackend.updateJob = vi.fn(async (_id, patch) => {
      stored = { ...stored, ...patch } as Job
      return stored
    })
    ctx.stateBackend.getJob = vi.fn(async () => stored)

    const result = await switchWorkflow(
      {
        workflowPath: 'workflows/job-fast/workflow.md',
        paramsPatch: { lane: 'fast' },
        reason: 'planner: small change → fast lane',
      },
      ctx,
      signals,
    )

    expect(result.ok).toBe(true)
    expect(result.workflowPath).toBe('workflows/job-fast/workflow.md')
    expect(result.phase).toBe('fast-coding')
    expect(result.by).toBe('switch_workflow')
    expect(signals.nextPhase).toBe('fast-coding')

    expect(stored.workflowPath).toBe('workflows/job-fast/workflow.md')
    expect(stored.phase).toBe('fast-coding')
    expect(stored.sessionId).toBeUndefined()
    expect(stored.params).toMatchObject({ repoSlug: 'svc', lane: 'fast' })
    expect(stored.workflowPathHistory).toHaveLength(1)
    expect(stored.workflowPathHistory?.[0]).toMatchObject({
      from: 'workflows/job/workflow.md',
      to: 'workflows/job-fast/workflow.md',
      fromPhase: 'planning',
      toPhase: 'fast-coding',
      reason: 'planner: small change → fast lane',
      by: 'switch_workflow',
    })
  })

  it('rejects unknown workflow path with helpful error', async () => {
    tmpDir = withTempIntelligence({})
    setIntelligenceDir(ctx, tmpDir)

    await expect(
      switchWorkflow(
        { workflowPath: 'workflows/does-not-exist/workflow.md', reason: 'x' },
        ctx,
        signals,
      ),
    ).rejects.toThrow(/was not found/)
    expect(signals.nextPhase).toBeUndefined()
  })

  it('refuses to switch into the campaign workflow when epicAllowed=false', async () => {
    tmpDir = withTempIntelligence({
      [CAMPAIGN_WORKFLOW_PATH]: WORKFLOW_CAMPAIGN,
    })
    setIntelligenceDir(ctx, tmpDir)

    ctx.job = makeMockJob({
      workflowPath: 'workflows/job/workflow.md',
      params: { epicAllowed: false },
    }) as Job

    await expect(
      switchWorkflow(
        { workflowPath: CAMPAIGN_WORKFLOW_PATH, reason: 'try to recurse' },
        ctx,
        signals,
      ),
    ).rejects.toThrow(/epicAllowed=false/)
  })

  it('returns no-op when target equals current workflow (no signal, no history)', async () => {
    tmpDir = withTempIntelligence({
      'workflows/job-fast/workflow.md': WORKFLOW_JOB_FAST,
    })
    setIntelligenceDir(ctx, tmpDir)

    ctx.job = makeMockJob({ workflowPath: 'workflows/job-fast/workflow.md' }) as Job
    let stored: Job = ctx.job
    ctx.stateBackend.updateJob = vi.fn(async (_id, patch) => {
      stored = { ...stored, ...patch } as Job
      return stored
    })

    const result = await switchWorkflow(
      { workflowPath: 'workflows/job-fast/workflow.md', reason: 'redundant' },
      ctx,
      signals,
    )

    expect(result.noop).toBe(true)
    expect(signals.nextPhase).toBeUndefined()
    expect(ctx.stateBackend.updateJob).not.toHaveBeenCalled()
    expect(stored.workflowPathHistory).toBeUndefined()
  })

  it('honours toPhase when valid; rejects when not declared', async () => {
    tmpDir = withTempIntelligence({
      'workflows/job-fast/workflow.md': WORKFLOW_JOB_FAST,
    })
    setIntelligenceDir(ctx, tmpDir)

    ctx.job = makeMockJob({ workflowPath: 'workflows/job/workflow.md' }) as Job
    let stored: Job = ctx.job
    ctx.stateBackend.updateJob = vi.fn(async (_id, patch) => {
      stored = { ...stored, ...patch } as Job
      return stored
    })
    ctx.stateBackend.getJob = vi.fn(async () => stored)

    const ok = await switchWorkflow(
      {
        workflowPath: 'workflows/job-fast/workflow.md',
        toPhase: 'fast-merge',
        reason: 'resume on merge',
      },
      ctx,
      signals,
    )
    expect(ok.phase).toBe('fast-merge')
    expect(signals.nextPhase).toBe('fast-merge')

    // Reset for invalid case.
    ctx.job = makeMockJob({ workflowPath: 'workflows/job/workflow.md' }) as Job
    stored = ctx.job
    signals = {}
    await expect(
      switchWorkflow(
        {
          workflowPath: 'workflows/job-fast/workflow.md',
          toPhase: 'nonexistent-phase',
          reason: 'bad',
        },
        ctx,
        signals,
      ),
    ).rejects.toThrow(/not declared/)
    expect(signals.nextPhase).toBeUndefined()
  })

  it('requires non-empty workflowPath and reason', async () => {
    await expect(
      switchWorkflow({ workflowPath: '', reason: 'x' }, ctx, signals),
    ).rejects.toThrow(/non-empty workflowPath/)

    await expect(
      switchWorkflow({ workflowPath: 'workflows/job-fast/workflow.md', reason: '' }, ctx, signals),
    ).rejects.toThrow(/non-empty reason/)
  })

  it('preserves existing params and workItems on switch', async () => {
    tmpDir = withTempIntelligence({
      'workflows/job-fast/workflow.md': WORKFLOW_JOB_FAST,
    })
    setIntelligenceDir(ctx, tmpDir)

    const startingJob = makeMockJob({
      workflowPath: 'workflows/job/workflow.md',
      params: { repoSlug: 'svc', reviewers: ['alice'], description: 'x' },
      workItems: [{ name: 'wi-1', description: 'do thing', status: 'pending', loopCount: 0 }],
    }) as Job
    ctx.job = startingJob

    let stored: Job = startingJob
    ctx.stateBackend.updateJob = vi.fn(async (_id, patch) => {
      stored = { ...stored, ...patch } as Job
      return stored
    })
    ctx.stateBackend.getJob = vi.fn(async () => stored)

    await switchWorkflow(
      {
        workflowPath: 'workflows/job-fast/workflow.md',
        paramsPatch: { lane: 'fast' },
        reason: 'lane sizing',
      },
      ctx,
      signals,
    )

    expect(stored.params).toEqual({
      repoSlug: 'svc',
      reviewers: ['alice'],
      description: 'x',
      lane: 'fast',
    })
    expect(stored.workItems).toEqual([
      { name: 'wi-1', description: 'do thing', status: 'pending', loopCount: 0 },
    ])
  })

  it('appends to an existing workflowPathHistory rather than overwriting', async () => {
    tmpDir = withTempIntelligence({
      'workflows/job-fast/workflow.md': WORKFLOW_JOB_FAST,
    })
    setIntelligenceDir(ctx, tmpDir)

    const startingJob = makeMockJob({
      workflowPath: 'workflows/job/workflow.md',
      workflowPathHistory: [
        {
          at: '2026-01-01T00:00:00Z',
          from: 'workflows/job-deep/workflow.md',
          to: 'workflows/job/workflow.md',
          fromPhase: 'analysis',
          toPhase: 'planning',
          reason: 'evaluator: down-shift',
          by: 'switch_workflow',
        },
      ],
    }) as Job
    ctx.job = startingJob

    let stored: Job = startingJob
    ctx.stateBackend.updateJob = vi.fn(async (_id, patch) => {
      stored = { ...stored, ...patch } as Job
      return stored
    })
    ctx.stateBackend.getJob = vi.fn(async () => stored)

    await switchWorkflow(
      { workflowPath: 'workflows/job-fast/workflow.md', reason: 'planner: shrink' },
      ctx,
      signals,
    )

    expect(stored.workflowPathHistory).toHaveLength(2)
    expect(stored.workflowPathHistory?.[1].to).toBe('workflows/job-fast/workflow.md')
  })
})
