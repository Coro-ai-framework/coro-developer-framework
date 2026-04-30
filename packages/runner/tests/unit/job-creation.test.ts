import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { buildJobRecord, WorkflowResolutionError } from '../../src/jobs/creation'
import { JobType } from '../../src/jobs/types'

// ── Setup helpers ────────────────────────────────────────────────────────────

const noopLogger = { warn: (): void => {}, debug: (): void => {} }

let tmp: string
let tenantRoot: string
let baseRoot: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'coro-creation-'))
  tenantRoot = path.join(tmp, 'tenant')
  baseRoot = path.join(tmp, 'base')
  await fs.mkdir(path.join(tenantRoot, 'workflows', 'job'), { recursive: true })
  await fs.mkdir(path.join(baseRoot, 'workflows', 'job'), { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('buildJobRecord (workflow resolution)', () => {
  it('uses the tenant overlay when it has the workflow', async () => {
    await fs.writeFile(
      path.join(tenantRoot, 'workflows', 'job', 'workflow.md'),
      `---\ninitial_phase: planning\ninitial_status: queued\nphases:\n  - name: planning\n    agent: agents/planner.md\n    model: planning\n    status: planning\n---\n`,
    )

    const job = await buildJobRecord(
      { type: 'job', triggerSource: 'cli', params: { serviceName: 'svc' } },
      JobType.Job,
      'workflows/job/workflow.md',
      { coroIntelligenceDir: tenantRoot, baseLayerDir: baseRoot, logger: noopLogger },
    )

    expect(job.phase).toBe('planning')
    expect(job.status).toBe('planning')
    expect(job.workflowPath).toBe('workflows/job/workflow.md')
  })

  it('falls back to the base layer when the tenant overlay is empty', async () => {
    await fs.writeFile(
      path.join(baseRoot, 'workflows', 'job', 'workflow.md'),
      `---\ninitial_phase: planning\ninitial_status: queued\nphases:\n  - name: planning\n    agent: agents/planner.md\n    model: planning\n    status: planning\n---\n`,
    )

    const job = await buildJobRecord(
      { type: 'job', triggerSource: 'cli', params: { serviceName: 'svc' } },
      JobType.Job,
      'workflows/job/workflow.md',
      { coroIntelligenceDir: tenantRoot, baseLayerDir: baseRoot, logger: noopLogger },
    )

    expect(job.phase).toBe('planning')
    expect(job.status).toBe('planning')
  })

  it('throws WorkflowResolutionError when no root has the workflow', async () => {
    await expect(
      buildJobRecord(
        { type: 'job', triggerSource: 'cli', params: {} },
        JobType.Job,
        'workflows/job/workflow.md',
        { coroIntelligenceDir: tenantRoot, baseLayerDir: baseRoot, logger: noopLogger },
      ),
    ).rejects.toBeInstanceOf(WorkflowResolutionError)
  })

  it("throws when initial_phase doesn't appear in the phase list", async () => {
    await fs.writeFile(
      path.join(baseRoot, 'workflows', 'job', 'workflow.md'),
      `---\ninitial_phase: nonexistent\nphases:\n  - name: planning\n    model: planning\n    status: planning\n---\n`,
    )

    await expect(
      buildJobRecord(
        { type: 'job', triggerSource: 'cli', params: {} },
        JobType.Job,
        'workflows/job/workflow.md',
        { coroIntelligenceDir: tenantRoot, baseLayerDir: baseRoot, logger: noopLogger },
      ),
    ).rejects.toThrow(/initial_phase='nonexistent'/)
  })

  it('refuses an empty workflowPath rather than fabricating a placeholder phase', async () => {
    await expect(
      buildJobRecord(
        { type: 'job', triggerSource: 'cli', params: {} },
        JobType.Job,
        '',
        { coroIntelligenceDir: tenantRoot, baseLayerDir: baseRoot, logger: noopLogger },
      ),
    ).rejects.toThrow(/non-empty workflowPath/)
  })

  it('honours trigger-source overrides (e.g. jira → spec-writing)', async () => {
    await fs.writeFile(
      path.join(baseRoot, 'workflows', 'job', 'workflow.md'),
      `---\ninitial_phase: planning\nphases:\n  - name: spec-writing\n    model: planning\n    status: spec-writing\n  - name: planning\n    model: planning\n    status: planning\noverrides:\n  jira:\n    initial_phase: spec-writing\n---\n`,
    )

    const job = await buildJobRecord(
      {
        type: 'job',
        triggerSource: 'jira',
        params: { serviceName: 'svc', jiraTicketId: 'PROJ-1' },
      },
      JobType.Job,
      'workflows/job/workflow.md',
      { coroIntelligenceDir: tenantRoot, baseLayerDir: baseRoot, logger: noopLogger },
    )

    expect(job.phase).toBe('spec-writing')
    expect(job.status).toBe('spec-writing')
  })
})
