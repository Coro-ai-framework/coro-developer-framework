import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runJob, type RunnerContext, type QueryInvocation } from '../../src/jobs/runner'
import {
  JobType,
  STATUS_COMPLETE,
  STATUS_ESCALATED,
  STATUS_FAILED,
  STATUS_AWAITING_PR_MERGE,
  STATUS_AWAITING_PLAN_APPROVAL,
} from '../../src/jobs/types'
import type { Job } from '../../src/jobs/types'
import type { WorkflowConfig } from '../../src/workflow-parser'
import type { Settings } from '../../src/config/settings'

vi.mock('../../src/prompt/builder', () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue('# Mock system prompt for runner tests'),
}))

function makeSettings(): Settings {
  return {
    host: { port: 3000, webhookSecret: 's', logLevel: 'silent' },
    claude: { apiKey: 'k', planningModel: 'plan-model', codingModel: 'code-model' },
    bitbucket: {
      workspace: 'ws',
      baseUrl: 'https://api.bitbucket.org/2.0',
      coderAccount: { username: 'c', appPassword: 'p' },
      reviewerAccount: { username: 'r', appPassword: 'p' },
    },
    redis: { url: 'redis://localhost' },
    paths: { workingDir: '/tmp/a5-work', a5aiDir: '/tmp/a5-ai' },
    loki: { baseUrl: '', apiKey: '', username: '' },
    tempo: { baseUrl: '', apiKey: '' },
    jira: { baseUrl: '', username: '', apiToken: '', pollIntervalSeconds: 60 },
    ngrok: { authToken: '', staticDomain: '' },
  }
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'runner-job-1',
    type: JobType.Migration,
    workflowPath: '',
    params: { serviceName: 'svc', repoSlug: 'svc' },
    triggerSource: 'cli',
    status: 'queued',
    phase: 'alpha',
    currentFeature: null,
    prMappings: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const workflowTwoPhase: WorkflowConfig = {
  initialPhase: 'alpha',
  initialStatus: 'queued',
  phases: [
    { name: 'alpha', agent: null, model: 'planning', status: 'running-alpha' },
    { name: 'beta', agent: null, model: 'planning', status: 'running-beta' },
  ],
  overrides: {},
}

const workflowSingle: WorkflowConfig = {
  initialPhase: 'only',
  initialStatus: 'queued',
  phases: [{ name: 'only', agent: null, model: 'planning', status: 'running-only' }],
  overrides: {},
}

function createMockRegistry(initial: Job) {
  let current: Job = { ...initial }
  return {
    get current(): Job {
      return current
    },
    getJob: vi.fn(async () => ({ ...current })),
    mapPrToJob: vi.fn().mockResolvedValue(undefined),
    updateJob: vi.fn(async (_id: string, patch: Partial<Job>) => {
      current = {
        ...current,
        ...patch,
        id: current.id,
        type: current.type,
        workflowPath: current.workflowPath,
        createdAt: current.createdAt,
      }
      return current
    }),
    appendLog: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn(async () => current),
    mapPrToJob: vi.fn().mockResolvedValue(undefined),
  }
}

type MockRegistry = ReturnType<typeof createMockRegistry>

function makeRunnerContext(registry: MockRegistry): RunnerContext {
  return {
    registry: registry as unknown as RunnerContext['registry'],
    settings: makeSettings(),
    gitClient: {} as RunnerContext['gitClient'],
    bbCoder: {} as RunnerContext['bbCoder'],
    bbReviewer: {} as RunnerContext['bbReviewer'],
    lokiClient: {} as RunnerContext['lokiClient'],
    tempoClient: {} as RunnerContext['tempoClient'],
    jiraClient: {} as RunnerContext['jiraClient'],
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as RunnerContext['logger'],
  }
}

describe('runJob (mocked Agent SDK query)', () => {
  let registry: MockRegistry
  let ctx: RunnerContext

  beforeEach(() => {
    registry = createMockRegistry(makeJob({ phase: 'alpha', status: 'queued' }))
    ctx = makeRunnerContext(registry)
  })

  it('completes a single-phase workflow when phaseComplete is signalled', async () => {
    const queryImpl = (inv: QueryInvocation) =>
      (async function* () {
        inv.signals.phaseComplete = true
        yield { type: 'system', session_id: 'sess-single' }
      })()

    await runJob(makeJob({ phase: 'only' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowSingle,
    })

    expect(registry.current.status).toBe(STATUS_COMPLETE)
    expect(registry.updateJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sessionId: 'sess-single' }),
    )
  })

  it('advances phases then completes', async () => {
    let call = 0
    const queryImpl = (inv: QueryInvocation) =>
      (async function* () {
        call += 1
        inv.signals.phaseComplete = true
        yield { type: 'system', session_id: `sess-${call}` }
      })()

    await runJob(makeJob({ phase: 'alpha' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowTwoPhase,
    })

    expect(call).toBe(2)
    expect(registry.current.status).toBe(STATUS_COMPLETE)
    expect(registry.current.phase).toBe('beta')
    // After first phase advance, phase is beta; job completes when no next phase after second complete
    // Actually: first call completes alpha -> advance to beta. Second call completes beta -> no next -> COMPLETE
    expect(registry.appendLog).toHaveBeenCalledWith(
      'runner-job-1',
      expect.stringContaining('Phase advanced → beta'),
    )
  })

  it('parks with awaiting-pr-merge when event name has no "plan" substring', async () => {
    const queryImpl = (inv: QueryInvocation) =>
      (async function* () {
        inv.signals.awaitingEvent = 'pr:merged'
        inv.signals.awaitingPrId = 99
        yield { type: 'system', session_id: 's1' }
      })()

    await runJob(makeJob({ phase: 'alpha' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowTwoPhase,
    })

    expect(registry.current.status).toBe(STATUS_AWAITING_PR_MERGE)
    expect(registry.current.awaitingEvent).toBe('pr:merged')
    expect(registry.current.awaitingPrId).toBe(99)
  })

  it('parks with awaiting-plan-approval when event name includes "plan"', async () => {
    const queryImpl = (inv: QueryInvocation) =>
      (async function* () {
        inv.signals.awaitingEvent = 'plan:approved'
        yield { type: 'system' }
      })()

    await runJob(makeJob({ phase: 'alpha' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowTwoPhase,
    })

    expect(registry.current.status).toBe(STATUS_AWAITING_PLAN_APPROVAL)
  })

  it('escalates when query ends without job-control signals', async () => {
    const queryImpl = () =>
      (async function* () {
        yield { type: 'system', session_id: 'orphan' }
      })()

    await runJob(makeJob({ phase: 'alpha' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowTwoPhase,
    })

    expect(registry.current.status).toBe(STATUS_ESCALATED)
    expect(registry.current.escalationMessage).toContain('mark_phase_complete')
  })

  it('persists sessionId from system messages', async () => {
    const queryImpl = (inv: QueryInvocation) =>
      (async function* () {
        inv.signals.phaseComplete = true
        yield { type: 'system', session_id: 'persist-me' }
      })()

    await runJob(makeJob({ phase: 'only' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowSingle,
    })

    expect(registry.current.sessionId).toBe('persist-me')
  })

  it('logs assistant string content (truncated)', async () => {
    const queryImpl = (inv: QueryInvocation) =>
      (async function* () {
        inv.signals.phaseComplete = true
        yield { type: 'assistant', content: 'Hello from the assistant' }
        yield { type: 'system', session_id: 'x' }
      })()

    await runJob(makeJob({ phase: 'only' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowSingle,
    })

    expect(registry.appendLog).toHaveBeenCalledWith('runner-job-1', 'Hello from the assistant')
  })

  it('logs tool_use_summary tool name', async () => {
    const queryImpl = (inv: QueryInvocation) =>
      (async function* () {
        inv.signals.phaseComplete = true
        yield { type: 'tool_use_summary', tool_name: 'Read' }
        yield { type: 'system', session_id: 'x' }
      })()

    await runJob(makeJob({ phase: 'only' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowSingle,
    })

    expect(registry.appendLog).toHaveBeenCalledWith('runner-job-1', '→ Read')
  })

  it('marks job failed when query throws', async () => {
    const queryImpl = () =>
      (async function* () {
        yield { type: 'system' }
        throw new Error('SDK exploded')
      })()

    await runJob(makeJob({ phase: 'only' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowSingle,
    })

    expect(registry.current.status).toBe(STATUS_FAILED)
    expect(registry.current.escalationMessage).toContain('SDK exploded')
    expect(ctx.logger.error).toHaveBeenCalled()
  })

  it('stops when escalated signal is set (after registry update)', async () => {
    const queryImpl = async function* (inv: QueryInvocation) {
      await inv.toolCtx.registry.updateJob(inv.toolCtx.job.id, {
        status: STATUS_ESCALATED,
        escalationMessage: 'Human needed',
      })
      inv.signals.escalated = true
      yield { type: 'system' }
    }

    await runJob(makeJob({ phase: 'alpha' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowTwoPhase,
    })

    expect(registry.current.status).toBe(STATUS_ESCALATED)
    expect(registry.current.escalationMessage).toBe('Human needed')
  })

  it('uses phase transition prompt when sessionId exists on second phase', async () => {
    const prompts: string[] = []
    let n = 0
    const queryImpl = (inv: QueryInvocation) =>
      (async function* () {
        n += 1
        prompts.push(inv.prompt)
        inv.signals.phaseComplete = true
        yield { type: 'system', session_id: `sess-${n}` }
      })()

    await runJob(makeJob({ phase: 'alpha' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowTwoPhase,
    })

    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('A new migration job has started')
    expect(prompts[1]).toContain('advancing to phase')
    expect(prompts[1]).toContain('beta')
  })
})
