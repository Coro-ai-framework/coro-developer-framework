import path from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import {
  runJob,
  type RunJobOptions,
  type RunnerContext,
} from '../../src/jobs/runner'
import { buildPhaseHooks, reattachDynamicMcpServers } from '@coro/llm-anthropic'
import {
  STATUS_CANCELLED,
  JobType,
  STATUS_COMPLETE,
  STATUS_ESCALATED,
  STATUS_FAILED,
  STATUS_AWAITING_PR_MERGE,
  STATUS_AWAITING_PLAN_APPROVAL,
  STATUS_AWAITING_DEVELOPER_INPUT,
} from '@coro/cloud-protocol'
import { emptyTokenUsage } from '../../src/jobs/helpers'
import type { Job } from '@coro/cloud-protocol'
import type { WorkflowConfig } from '../../src/workflow-parser'
import type { Settings } from '../../src/config/settings'
import { PluginRegistry } from '../../src/plugins/registry'
import type { ScmPluginRuntime } from '../../src/plugins'
import type {
  PhaseExecutionRequest,
  PhaseExecutorEvent,
  PhaseExecutorRuntime,
} from '../../src/plugins/types'
import type { PhaseSignals, ToolContext } from '../../src/tools/types'

vi.mock('../../src/prompt/builder', () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue('# Mock system prompt for runner tests'),
  computeScmPromptContext: vi.fn().mockReturnValue({ available: true, resolved: 'github', installed: ['github'] }),
  // The runner now calls this once per phase to assemble the tracker block
  // before delegating to `buildSystemPrompt`. We mock it as a no-op pure
  // function so the runner's call site stays exercised without forcing
  // every test to wire up a real Settings + TrackerClient pair.
  computeTrackerPromptContext: vi.fn().mockReturnValue({ provider: 'none', available: false }),
}))

vi.mock('@coro/llm-anthropic', async () => {
  const actual = await vi.importActual<typeof import('@coro/llm-anthropic')>('@coro/llm-anthropic')
  return {
    ...actual,
    resolveClaudeCodeCliPath: vi.fn().mockReturnValue('/tmp/mock-claude-cli.js'),
    ensureClaudeCodeCliExecutable: vi.fn(),
  }
})

function makeSettings(): Settings {
  return {
    host: { port: 3000, webhookSecret: 's', logLevel: 'silent' },
    bitbucket: {
      workspace: 'ws',
      baseUrl: 'https://api.bitbucket.org/2.0',
      coderAccount: { username: 'c', appPassword: 'p' },
      reviewerAccount: { username: 'r', appPassword: 'p' },
    },
    github: { owner: '', token: '', baseUrl: 'https://api.github.com' },
    redis: { url: 'redis://localhost' },
    paths: {
      workingDir: '/tmp/coro-work',
      coroIntelligenceDir: '/tmp/coro-intelligence',
      baseLayerDir: '/tmp/coro-base-layer',
    },
    loki: { baseUrl: '', apiKey: '', username: '' },
    tempo: { baseUrl: '', apiKey: '' },
    jira: { baseUrl: '', username: '', apiToken: '', pollIntervalSeconds: 60 },
    ngrok: { authToken: '', staticDomain: '' },
    proposals: { routing: { strategy: 'path' } },
    llm: {
      defaultProvider: 'anthropic',
      providers: {},
      aliases: {
        planning: { provider: 'anthropic', model: 'plan-model' },
        coding: { provider: 'anthropic', model: 'code-model' },
      },
    },
  }
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'runner-job-1',
    type: JobType.Job,
    workflowPath: '',
    params: { serviceName: 'svc', repoSlug: 'svc' },
    triggerSource: 'cli',
    status: 'queued',
    phase: 'alpha',
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

function createMockStateBackend(initial: Job) {
  let current: Job = { ...initial }
  return {
    get current(): Job {
      return current
    },
    getJob: vi.fn(async () => current),
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
  }
}

const cancellationPatch = {
  status: STATUS_CANCELLED,
  awaitingEvent: undefined,
  awaitingPrId: undefined,
  awaitingNextPhase: undefined,
  approvedAdvanceFromPhase: undefined,
  pendingPrompt: undefined,
  escalationMessage: undefined,
} as const

type MockStateBackend = ReturnType<typeof createMockStateBackend>

function makeRunnerContext(stateBackend: MockStateBackend): RunnerContext {
  const plugins = new PluginRegistry()
  plugins.register(fakeScmPlugin('github'))

  return {
    stateBackend: stateBackend as unknown as RunnerContext['stateBackend'],
    settings: makeSettings(),
    tenantContext: {
      tenantId: 'solo-test-host',
      mode: 'solo',
      displayName: 'Solo (test-host)',
      overlay: { kind: 'none' },
    },
    gitClient: {
      pull: vi.fn().mockResolvedValue(undefined),
    } as unknown as RunnerContext['gitClient'],
    bbCoder: {} as RunnerContext['bbCoder'],
    bbReviewer: {} as RunnerContext['bbReviewer'],
    ghClient: null,
    ghGitClient: null,
    lokiClient: {} as RunnerContext['lokiClient'],
    tempoClient: {} as RunnerContext['tempoClient'],
    jiraClient: {} as RunnerContext['jiraClient'],
    // The runner now calls `trackerClient.isAvailable()` and reads `.provider`
    // every phase to assemble the prompt's tracker block — supply a tiny stub
    // so the mock context is a faithful shape rather than a TypeScript-only
    // assertion. Tests that exercise tracker behaviour explicitly should
    // override this with a richer mock.
    trackerClient: {
      provider: 'jira',
      isAvailable: () => false,
    } as unknown as RunnerContext['trackerClient'],
    plugins,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as RunnerContext['logger'],
  }
}

function fakeScmPlugin(id: string): ScmPluginRuntime {
  return {
    manifest: {
      id,
      kind: 'scm',
      version: '0.0.1',
      displayName: id,
      hostCompatibility: '*',
      configSchema: z.object({}),
    },
    kind: 'scm',
    init: async () => {},
    healthcheck: async () => ({ ok: true }),
    dispose: async () => {},
    cloneInfo: () => ({ url: 'fake', envForGit: {} }),
    createPr: async () => ({ kind: 'pull_request', pluginId: id, repoKey: 'repo', externalId: '1' }),
    getPrStatus: async () => ({ state: 'open', approvalCount: 0 }),
    listPrComments: async () => [],
    postPrComment: async (_ref, body) => ({ id: '1', body, createdAt: '', updatedAt: '' }),
    replyToComment: async (_ref, parentId, body) => ({ id: '2', body, createdAt: '', updatedAt: '', parentId }),
    pollPr: async () => ({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] }),
    normalizeInbound: () => null,
    matchesRemote: () => false,
  }
}

async function capturePreToolUseHook(
  ctx: RunnerContext,
  workflowConfig: WorkflowConfig = workflowSingle,
): Promise<(input: Record<string, unknown>) => Promise<unknown>> {
  // Hooks are now built INSIDE the executor (`AnthropicExecutor` calls
  // `buildPhaseHooks` from the runner-supplied {@link HookPolicy}). The
  // test reproduces the same call shape the runner uses to wire the
  // hook into a phase, then invokes it directly.
  const phase = workflowConfig.phases[0]!
  const hooks = buildPhaseHooks({
    liveJobRef: () => ({ phase: phase.name }),
    workingDir: path.join(ctx.settings.paths.workingDir, 'runner-job-1'),
    coroIntelligenceDir: ctx.settings.paths.coroIntelligenceDir,
    allowedTools: phase.tools,
    logger: ctx.logger,
  })
  const preToolUse = hooks.PreToolUse?.[0]?.hooks?.[0] as
    | ((input: Record<string, unknown>) => Promise<unknown>)
    | undefined
  if (!preToolUse) {
    throw new Error('PreToolUse hook was not produced by buildPhaseHooks')
  }
  return preToolUse
}

// ── Stub PhaseExecutorRuntime helpers ──────────────────────────────────────
//
// The runner's contract with executors is the {@link PhaseExecutorRuntime}
// interface: a per-phase `executePhase(req)` returning an
// `AsyncIterable<PhaseExecutorEvent>`. Tests build a small stub whose
// generator function gets a captured handle to the live
// {@link PhaseSignals} + {@link ToolContext} so it can mutate signals
// (`nextPhase`, `awaitingEvent`, `escalated`) the way a real
// `mcp__coro__*` tool call would.

type StubGenerator = (
  req: PhaseExecutionRequest,
  helpers: { signals: PhaseSignals; toolCtx: ToolContext },
) => AsyncIterable<PhaseExecutorEvent>

interface StubExecutorBundle {
  executor: PhaseExecutorRuntime
  bootHook: NonNullable<RunJobOptions['onPhaseExecutorBoot']>
  /** Records of every PhaseExecutionRequest the runner handed to the executor. */
  capturedRequests: PhaseExecutionRequest[]
}

function makeStubExecutor(generate: StubGenerator): StubExecutorBundle {
  const helpers: { signals?: PhaseSignals; toolCtx?: ToolContext } = {}
  const capturedRequests: PhaseExecutionRequest[] = []
  const executor = {
    kind: 'executor' as const,
    capabilities: {
      supportsClaudeMdNativeWalkUp: false,
      supportsStreamingTokenUsage: true,
      supportsThinking: true,
      supportsResumeSession: true,
      supportsSubagents: true,
    },
    manifest: {
      id: 'test-stub-executor',
      kind: 'executor' as const,
      version: '0.0.1',
      displayName: 'Test stub executor',
      hostCompatibility: '*',
      configSchema: z.object({}),
    },
    supports: () => true,
    listModels: () => [],
    init: async () => {},
    healthcheck: async () => ({ ok: true }),
    dispose: async () => {},
    executePhase(req: PhaseExecutionRequest): AsyncIterable<PhaseExecutorEvent> {
      capturedRequests.push(req)
      return generate(req, helpers as { signals: PhaseSignals; toolCtx: ToolContext })
    },
  } as unknown as PhaseExecutorRuntime
  return {
    executor,
    bootHook: (_jobId, ctx) => {
      helpers.signals = ctx.signals
      helpers.toolCtx = ctx.toolCtx
    },
    capturedRequests,
  }
}

/**
 * Convenience wrapper that runs a job against a stub executor and
 * wires both the executor and the boot hook. Tests that need to
 * inspect captured requests should create the bundle manually.
 */
async function runWithStubExecutor(
  job: Job,
  ctx: RunnerContext,
  generate: StubGenerator,
  options: Omit<RunJobOptions, 'executorImpl' | 'onPhaseExecutorBoot'> = {},
): Promise<StubExecutorBundle> {
  const bundle = makeStubExecutor(generate)
  await runJob(job, ctx, {
    ...options,
    executorImpl: bundle.executor,
    onPhaseExecutorBoot: bundle.bootHook,
  })
  return bundle
}

/**
 * Helper: yield the canonical "phase ran with no model turns" sequence
 * — a session_start sets the sessionId, a done event closes the phase
 * with zero metrics. Used by tests that don't care about token usage.
 */
async function* yieldEmptyPhase(sessionId: string): AsyncIterable<PhaseExecutorEvent> {
  yield { type: 'session_start', sessionId }
  yield {
    type: 'done',
    stopReason: 'end_turn',
    sessionState: { sessionId },
    metrics: { numTurns: 0 },
  }
}

describe('runJob (mocked Agent SDK query)', () => {
  let stateBackend: MockStateBackend
  let ctx: RunnerContext

  beforeEach(() => {
    stateBackend = createMockStateBackend(makeJob({ phase: 'alpha', status: 'queued' }))
    ctx = makeRunnerContext(stateBackend)
  })

  it('completes a single-phase workflow when the stream ends', async () => {
    await runWithStubExecutor(
      makeJob({ phase: 'only' }),
      ctx,
      () => yieldEmptyPhase('sess-single'),
      { workflowConfigOverride: workflowSingle },
    )

    expect(stateBackend.current.status).toBe(STATUS_COMPLETE)
    expect(stateBackend.updateJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sessionId: 'sess-single' }),
    )
  })

  describe('completion gate', () => {
    it('completes immediately when all work items are complete', async () => {
      stateBackend = createMockStateBackend(makeJob({
        phase: 'only',
        status: 'queued',
        workItems: [
          { name: 'wi-1', status: 'complete', loopCount: 0 },
          { name: 'wi-2', status: 'complete', loopCount: 1 },
        ],
      }))
      ctx = makeRunnerContext(stateBackend)

      await runWithStubExecutor(
        makeJob({
          phase: 'only',
          workItems: [
            { name: 'wi-1', status: 'complete', loopCount: 0 },
            { name: 'wi-2', status: 'complete', loopCount: 1 },
          ],
        }),
        ctx,
        () => yieldEmptyPhase('sess-gate-ready'),
        { workflowConfigOverride: workflowSingle },
      )

      expect(stateBackend.current.status).toBe(STATUS_COMPLETE)
      expect(stateBackend.appendLog).not.toHaveBeenCalledWith(
        'runner-job-1',
        expect.stringContaining('[completion-gate] Blocking'),
      )
    })

    it('blocks completion and re-runs the same phase when work items are unfinished', async () => {
      const initialWorkItems = [
        { name: 'wi-1', status: 'complete' as const, loopCount: 0 },
        { name: 'wi-2', status: 'in-progress' as const, loopCount: 1 },
      ]
      stateBackend = createMockStateBackend(makeJob({
        phase: 'only',
        status: 'queued',
        workItems: initialWorkItems,
      }))
      ctx = makeRunnerContext(stateBackend)

      let call = 0
      await runWithStubExecutor(
        makeJob({
          phase: 'only',
          workItems: initialWorkItems,
        }),
        ctx,
        async function* () {
          call += 1
          if (call === 2) {
            // On the second invocation the agent finally marks the
            // remaining work item complete so the gate passes and the
            // job can finalise.
            await stateBackend.updateJob('runner-job-1', {
              workItems: [
                { name: 'wi-1', status: 'complete', loopCount: 0 },
                { name: 'wi-2', status: 'complete', loopCount: 2 },
              ],
            })
          }
          yield* yieldEmptyPhase(`sess-gate-${call}`)
        },
        { workflowConfigOverride: workflowSingle },
      )

      expect(call).toBe(2)
      expect(stateBackend.current.status).toBe(STATUS_COMPLETE)
      expect(stateBackend.current.phase).toBe('only')
      expect(stateBackend.appendLog).toHaveBeenCalledWith(
        'runner-job-1',
        expect.stringContaining('[completion-gate] Blocking job completion'),
      )
      // The corrective prompt is injected so the agent's next turn sees
      // exactly why the gate fired.
      expect(stateBackend.updateJob).toHaveBeenCalledWith(
        'runner-job-1',
        expect.objectContaining({
          pendingPrompt: expect.stringContaining('[completion-gate]'),
        }),
      )
    })

    it('fails the job after the retry cap is exceeded', async () => {
      stateBackend = createMockStateBackend(makeJob({
        phase: 'only',
        status: 'queued',
        workItems: [{ name: 'wi-1', status: 'pending', loopCount: 0 }],
      }))
      ctx = makeRunnerContext(stateBackend)

      let call = 0
      await runWithStubExecutor(
        makeJob({
          phase: 'only',
          workItems: [{ name: 'wi-1', status: 'pending', loopCount: 0 }],
        }),
        ctx,
        async function* () {
          call += 1
          yield* yieldEmptyPhase(`sess-gate-loop-${call}`)
        },
        { workflowConfigOverride: workflowSingle },
      )

      expect(stateBackend.current.status).toBe(STATUS_FAILED)
      expect(stateBackend.current.escalationMessage).toContain('completion gate')
      expect(stateBackend.appendLog).toHaveBeenCalledWith(
        'runner-job-1',
        expect.stringContaining('[completion-gate] Job failed'),
      )
    })
  })

  describe('coding preflight', () => {
    const workflowCoding: WorkflowConfig = {
      initialPhase: 'coding',
      initialStatus: 'queued',
      phases: [{ name: 'coding', agent: null, model: 'planning', status: 'running-coding' }],
      overrides: {},
    }
    const workflowReview: WorkflowConfig = {
      initialPhase: 'review',
      initialStatus: 'queued',
      phases: [{ name: 'review', agent: null, model: 'planning', status: 'running-review' }],
      overrides: {},
    }

    it('prepends [coding-preflight] when coding phase has open PRs for currentWorkItem', async () => {
      const bundle = makeStubExecutor(() => yieldEmptyPhase('sess-preflight'))
      await runJob(
        makeJob({
          phase: 'coding',
          status: 'queued',
          currentWorkItem: 'wi-1',
          prMappings: [
            { prId: 7, workItem: 'wi-1', repoSlug: 'svc', openedAt: '2026-01-01T00:00:00Z' },
          ],
        }),
        ctx,
        {
          executorImpl: bundle.executor,
          onPhaseExecutorBoot: bundle.bootHook,
          workflowConfigOverride: workflowCoding,
        },
      )

      const prompt = bundle.capturedRequests[0]?.userPrompt ?? ''
      expect(prompt).toContain('[coding-preflight]')
      expect(prompt).toContain('wi-1')
      expect(prompt).toContain('## Open PRs on this job')
    })

    it('does not prepend preflight in review phase', async () => {
      const bundle = makeStubExecutor(() => yieldEmptyPhase('sess-review'))
      await runJob(
        makeJob({
          phase: 'review',
          status: 'queued',
          currentWorkItem: 'wi-1',
          prMappings: [
            { prId: 7, workItem: 'wi-1', repoSlug: 'svc', openedAt: '2026-01-01T00:00:00Z' },
          ],
        }),
        ctx,
        {
          executorImpl: bundle.executor,
          onPhaseExecutorBoot: bundle.bootHook,
          workflowConfigOverride: workflowReview,
        },
      )

      const prompt = bundle.capturedRequests[0]?.userPrompt ?? ''
      expect(prompt).not.toContain('[coding-preflight]')
      expect(prompt).toContain('## Open PRs on this job')
    })
  })

  it('advances phases then completes', async () => {
    let call = 0
    await runWithStubExecutor(
      makeJob({ phase: 'alpha' }),
      ctx,
      async function* () {
        call += 1
        yield* yieldEmptyPhase(`sess-${call}`)
      },
      { workflowConfigOverride: workflowTwoPhase },
    )

    expect(call).toBe(2)
    expect(stateBackend.current.status).toBe(STATUS_COMPLETE)
    expect(stateBackend.current.phase).toBe('beta')
    // After first phase advance, phase is beta; job completes when no next phase after second complete
    // Actually: first call completes alpha -> advance to beta. Second call completes beta -> no next -> COMPLETE
    expect(stateBackend.appendLog).toHaveBeenCalledWith(
      'runner-job-1',
      expect.stringContaining('Phase advanced → beta'),
    )
  })

  it('parks with awaiting-pr-merge when event name has no "plan" substring', async () => {
    await runWithStubExecutor(
      makeJob({ phase: 'alpha' }),
      ctx,
      async function* (_req, h) {
        h.signals.awaitingEvent = 'pr:merged'
        h.signals.awaitingPrId = 99
        yield* yieldEmptyPhase('s1')
      },
      { workflowConfigOverride: workflowTwoPhase },
    )

    expect(stateBackend.current.status).toBe(STATUS_AWAITING_PR_MERGE)
    expect(stateBackend.current.awaitingEvent).toBe('pr:merged')
    expect(stateBackend.current.awaitingPrId).toBe(99)
  })

  it('parks with awaiting-developer-input when event name starts with "developer-input"', async () => {
    await runWithStubExecutor(
      makeJob({ phase: 'alpha' }),
      ctx,
      async function* (_req, h) {
        h.signals.awaitingEvent = 'developer-input: unclear if X should be idempotent'
        yield* yieldEmptyPhase('dev-input')
      },
      { workflowConfigOverride: workflowTwoPhase },
    )

    expect(stateBackend.current.status).toBe(STATUS_AWAITING_DEVELOPER_INPUT)
    expect(stateBackend.current.awaitingEvent).toBe(
      'developer-input: unclear if X should be idempotent',
    )
    expect(stateBackend.current.awaitingNextPhase).toBeUndefined()
    expect(stateBackend.current.phase).toBe('alpha')
  })

  it('parks at interactive checkpoints for interactive jobs before advancing', async () => {
    const workflowCheckpoint: WorkflowConfig = {
      initialPhase: 'alpha',
      initialStatus: 'queued',
      phases: [
        { name: 'alpha', agent: null, model: 'planning', status: 'running-alpha', interactiveCheckpoint: true },
        { name: 'beta', agent: null, model: 'planning', status: 'running-beta' },
      ],
      overrides: {},
    }

    stateBackend = createMockStateBackend(
      makeJob({ phase: 'alpha', status: 'queued', interactive: true }),
    )
    ctx = makeRunnerContext(stateBackend)

    await runWithStubExecutor(
      makeJob({ phase: 'alpha', interactive: true }),
      ctx,
      () => yieldEmptyPhase('sess-cp'),
      { workflowConfigOverride: workflowCheckpoint },
    )

    expect(stateBackend.current.status).toBe(STATUS_AWAITING_DEVELOPER_INPUT)
    expect(stateBackend.current.phase).toBe('alpha')
    expect(stateBackend.current.awaitingNextPhase).toBe('beta')
    expect(stateBackend.current.awaitingEvent).toBe('developer-input: approval after alpha')
  })

  it('records awaitingNextPhase when agent explicitly asks for approval in an interactive checkpoint phase', async () => {
    const workflowCheckpoint: WorkflowConfig = {
      initialPhase: 'alpha',
      initialStatus: 'queued',
      phases: [
        { name: 'alpha', agent: null, model: 'planning', status: 'running-alpha', interactiveCheckpoint: true },
        { name: 'beta', agent: null, model: 'planning', status: 'running-beta' },
      ],
      overrides: {},
    }

    stateBackend = createMockStateBackend(
      makeJob({ phase: 'alpha', status: 'queued', interactive: true }),
    )
    ctx = makeRunnerContext(stateBackend)

    await runWithStubExecutor(
      makeJob({ phase: 'alpha', interactive: true }),
      ctx,
      async function* (_req, h) {
        h.signals.awaitingEvent = 'developer-input: Approve implementation plan for alpha'
        yield* yieldEmptyPhase('sess-agent-approval')
      },
      { workflowConfigOverride: workflowCheckpoint },
    )

    expect(stateBackend.current.status).toBe(STATUS_AWAITING_DEVELOPER_INPUT)
    expect(stateBackend.current.phase).toBe('alpha')
    expect(stateBackend.current.awaitingNextPhase).toBe('beta')
    expect(stateBackend.current.awaitingEvent).toBe(
      'developer-input: Approve implementation plan for alpha',
    )
  })

  it('advances past an interactive checkpoint after developer approval', async () => {
    const workflowCheckpoint: WorkflowConfig = {
      initialPhase: 'alpha',
      initialStatus: 'queued',
      phases: [
        { name: 'alpha', agent: null, model: 'planning', status: 'running-alpha', interactiveCheckpoint: true },
        { name: 'beta', agent: null, model: 'planning', status: 'running-beta' },
      ],
      overrides: {},
    }

    stateBackend = createMockStateBackend(
      makeJob({
        phase: 'alpha',
        // Status is post-resume here: the dispatcher has already
        // cleared the parking status and stamped
        // `approvedAdvanceFromPhase` so the runner advances past the
        // checkpoint instead of immediately re-parking.
        status: 'queued',
        interactive: true,
        approvedAdvanceFromPhase: 'alpha',
      }),
    )
    ctx = makeRunnerContext(stateBackend)

    let call = 0
    await runWithStubExecutor(
      makeJob({ phase: 'alpha', interactive: true, approvedAdvanceFromPhase: 'alpha' }),
      ctx,
      async function* () {
        call += 1
        yield* yieldEmptyPhase(`sess-approved-${call}`)
      },
      { workflowConfigOverride: workflowCheckpoint },
    )

    expect(call).toBe(2)
    expect(stateBackend.current.status).toBe(STATUS_COMPLETE)
    expect(stateBackend.current.phase).toBe('beta')
    expect(stateBackend.current.approvedAdvanceFromPhase).toBeUndefined()
  })

  it('parks with awaiting-plan-approval when event name includes "plan"', async () => {
    await runWithStubExecutor(
      makeJob({ phase: 'alpha' }),
      ctx,
      async function* (_req, h) {
        h.signals.awaitingEvent = 'plan:approved'
        yield* yieldEmptyPhase('plan-park')
      },
      { workflowConfigOverride: workflowTwoPhase },
    )

    expect(stateBackend.current.status).toBe(STATUS_AWAITING_PLAN_APPROVAL)
  })

  it('auto-advances when query ends without any signal (no escalation)', async () => {
    let call = 0
    await runWithStubExecutor(
      makeJob({ phase: 'alpha' }),
      ctx,
      async function* () {
        call += 1
        yield* yieldEmptyPhase(`auto-${call}`)
      },
      { workflowConfigOverride: workflowTwoPhase },
    )

    expect(call).toBe(2)
    expect(stateBackend.current.status).toBe(STATUS_COMPLETE)
    expect(stateBackend.current.phase).toBe('beta')
  })

  it('stops at a safe boundary when the job is cancelled during the live turn', async () => {
    await runWithStubExecutor(
      makeJob({ phase: 'only' }),
      ctx,
      async function* () {
        await stateBackend.updateJob('runner-job-1', { ...cancellationPatch, phase: 'only' })
        yield* yieldEmptyPhase('sess-cancelled')
      },
      { workflowConfigOverride: workflowSingle },
    )

    expect(stateBackend.current.status).toBe(STATUS_CANCELLED)
    expect(stateBackend.current.phase).toBe('only')
    expect(stateBackend.appendLog).not.toHaveBeenCalledWith(
      'runner-job-1',
      expect.stringContaining('All phases complete'),
    )
  })

  it('does not park a cancelled job even if the agent already requested await_event', async () => {
    await runWithStubExecutor(
      makeJob({ phase: 'alpha' }),
      ctx,
      async function* (_req, h) {
        await stateBackend.updateJob('runner-job-1', cancellationPatch)
        h.signals.awaitingEvent = 'pr:merged'
        h.signals.awaitingPrId = 99
        yield* yieldEmptyPhase('sess-cancelled-await')
      },
      { workflowConfigOverride: workflowTwoPhase },
    )

    expect(stateBackend.current.status).toBe(STATUS_CANCELLED)
    expect(stateBackend.current.awaitingEvent).toBeUndefined()
    expect(stateBackend.current.awaitingPrId).toBeUndefined()
  })

  it('does not overwrite a cancelled job with failed when the active turn crashes', async () => {
    await runWithStubExecutor(
      makeJob({ phase: 'only' }),
      ctx,
      async function* () {
        await stateBackend.updateJob('runner-job-1', cancellationPatch)
        throw new Error('query crashed after cancel')
        yield { type: 'session_start', sessionId: 'never' } as PhaseExecutorEvent
      },
      { workflowConfigOverride: workflowSingle },
    )

    expect(stateBackend.current.status).toBe(STATUS_CANCELLED)
    expect(stateBackend.updateJob).not.toHaveBeenCalledWith(
      'runner-job-1',
      expect.objectContaining({ status: STATUS_FAILED }),
    )
  })

  it('persists sessionId from system messages', async () => {
    await runWithStubExecutor(
      makeJob({ phase: 'only' }),
      ctx,
      () => yieldEmptyPhase('persist-me'),
      { workflowConfigOverride: workflowSingle },
    )

    expect(stateBackend.current.sessionId).toBe('persist-me')
  })

  it('logs assistant text from BetaMessage content blocks', async () => {
    await runWithStubExecutor(
      makeJob({ phase: 'only' }),
      ctx,
      async function* () {
        yield { type: 'text', content: 'Hello from the assistant' }
        yield* yieldEmptyPhase('x')
      },
      { workflowConfigOverride: workflowSingle },
    )

    expect(stateBackend.appendLog).toHaveBeenCalledWith('runner-job-1', 'Hello from the assistant')
  })

  it('logs tool_use blocks from assistant message', async () => {
    await runWithStubExecutor(
      makeJob({ phase: 'only' }),
      ctx,
      async function* () {
        yield { type: 'tool_call', toolName: 'Read', input: { path: '/tmp/foo' }, isMcp: false }
        yield* yieldEmptyPhase('x')
      },
      { workflowConfigOverride: workflowSingle },
    )

    expect(stateBackend.appendLog).toHaveBeenCalledWith(
      'runner-job-1',
      expect.stringContaining('→ Read'),
    )
  })

  it('logs tool_use_summary with summary text', async () => {
    // The Anthropic executor maps the SDK's `tool_use_summary` event to
    // a `log` event with a `[tool_summary] ` prefix; the runner mirrors
    // every executor `log` event into the per-job log.
    await runWithStubExecutor(
      makeJob({ phase: 'only' }),
      ctx,
      async function* () {
        yield { type: 'log', level: 'info', message: '[tool_summary] Read 3 files in src/' }
        yield* yieldEmptyPhase('x')
      },
      { workflowConfigOverride: workflowSingle },
    )

    expect(stateBackend.appendLog).toHaveBeenCalledWith(
      'runner-job-1',
      '[tool_summary] Read 3 files in src/',
    )
  })

  it('chunks long thinking logs instead of truncating them', async () => {
    const longThinking = 'x'.repeat(4_200)
    await runWithStubExecutor(
      makeJob({ phase: 'only' }),
      ctx,
      async function* () {
        yield { type: 'thinking', content: longThinking }
        yield* yieldEmptyPhase('x')
      },
      { workflowConfigOverride: workflowSingle },
    )

    const thinkingLogs = stateBackend.appendLog.mock.calls
      .filter((call: unknown[]) => call[0] === 'runner-job-1' && typeof call[1] === 'string' && (call[1] as string).startsWith('[thinking] '))
      .map(call => (call[1] as string).slice('[thinking] '.length))

    expect(thinkingLogs.length).toBeGreaterThan(1)
    expect(thinkingLogs.join('')).toBe(longThinking)
  })

  it('marks job failed when query throws', async () => {
    await runWithStubExecutor(
      makeJob({ phase: 'only' }),
      ctx,
      async function* () {
        yield { type: 'session_start', sessionId: 'crash' }
        throw new Error('SDK exploded')
      },
      { workflowConfigOverride: workflowSingle },
    )

    expect(stateBackend.current.status).toBe(STATUS_FAILED)
    expect(stateBackend.current.escalationMessage).toContain('SDK exploded')
    expect(ctx.logger.error).toHaveBeenCalled()
  })

  it('warns but still auto-advances when built-in tools ran but no A5 MCP tool was used', async () => {
    await runWithStubExecutor(
      makeJob({ phase: 'alpha' }),
      ctx,
      async function* () {
        yield { type: 'tool_call', toolName: 'Bash', input: { command: 'git status' }, isMcp: false }
        yield* yieldEmptyPhase('missing-mcp')
      },
      { workflowConfigOverride: workflowTwoPhase },
    )

    expect(stateBackend.current.status).toBe(STATUS_COMPLETE)
    expect(stateBackend.current.phase).toBe('beta')
    expect(stateBackend.appendLog).toHaveBeenCalledWith(
      'runner-job-1',
      expect.stringContaining('ZERO mcp__coro__* calls'),
    )
  })

  it('allows Bash commands that stay within the workspace', async () => {
    const preToolUse = await capturePreToolUseHook(ctx)

    await expect(
      preToolUse({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
      }),
    ).resolves.toEqual({})
  })

  it('denies tools outside an explicit phase whitelist', async () => {
    const restrictedWorkflow: WorkflowConfig = {
      initialPhase: 'only',
      initialStatus: 'queued',
      phases: [{
        name: 'only',
        agent: null,
        model: 'planning',
        status: 'running-only',
        tools: ['Read', 'mcp__coro__log'],
      }],
      overrides: {},
    }

    const preToolUse = await capturePreToolUseHook(ctx, restrictedWorkflow)

    const result = await preToolUse({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    })

    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('only allows Read, mcp__coro__log'),
      },
    })
  })

  it('denies Bash commands that probe the user home', async () => {
    const preToolUse = await capturePreToolUseHook(ctx)

    const result = await preToolUse({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'find ~/src -maxdepth 2' },
    })

    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('home-relative path'),
      },
    })
  })

  it('denies Bash commands that escape via parent traversal', async () => {
    const preToolUse = await capturePreToolUseHook(ctx)

    const result = await preToolUse({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'cd .. && ls' },
    })

    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        // Since commit 3b70f71 the hook resolves `..` to an absolute path
        // up front and emits `references path <resolved> via ".."` rather
        // than a dedicated `parent-directory traversal` kind. The `via ".."`
        // fragment is the stable signal that this branch fired.
        permissionDecisionReason: expect.stringContaining('via ".."'),
      },
    })
  })

  it('denies Bash commands that read Claude runtime task output files', async () => {
    const preToolUse = await capturePreToolUseHook(ctx)

    const result = await preToolUse({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {
        command: 'cat /private/tmp/claude-501/example-session/tasks/abc123.output',
      },
    })

    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('/private/tmp/claude-*/tasks/*.output'),
      },
    })
    expect(result).toMatchObject({
      hookSpecificOutput: {
        permissionDecisionReason: expect.stringContaining('workspace file instead'),
      },
    })
  })

  it('passes subagent tool whitelists into SDK agent definitions', async () => {
    const workflowWithSubagent: WorkflowConfig = {
      initialPhase: 'only',
      initialStatus: 'queued',
      phases: [{
        name: 'only',
        agent: null,
        model: 'planning',
        status: 'running-only',
        subagents: [{
          name: 'reviewer',
          model: 'planning',
          tools: ['Read', 'Bash', 'mcp__coro__log'],
        }],
      }],
      overrides: {},
    }

    const bundle = await runWithStubExecutor(
      makeJob({ phase: 'only' }),
      ctx,
      () => yieldEmptyPhase('subagent-tools'),
      { workflowConfigOverride: workflowWithSubagent },
    )

    // The runner translates phase-config subagents into the executor
    // contract's `subagents` payload. Each entry carries the agent's
    // model + tool whitelist so the executor can encode the SDK shape.
    const reviewer = bundle.capturedRequests[0]?.subagents?.find(s => s.name === 'reviewer')
    expect(reviewer).toBeDefined()
    expect(reviewer!.allowedTools).toEqual(['Read', 'Bash', 'mcp__coro__log'])
  })

  it('stops when escalated signal is set (after stateBackend update)', async () => {
    await runWithStubExecutor(
      makeJob({ phase: 'alpha' }),
      ctx,
      async function* (_req, h) {
        await h.toolCtx.stateBackend.updateJob(h.toolCtx.job.id, {
          status: STATUS_ESCALATED,
          escalationMessage: 'Human needed',
        })
        h.signals.escalated = true
        yield* yieldEmptyPhase('escalated')
      },
      { workflowConfigOverride: workflowTwoPhase },
    )

    expect(stateBackend.current.status).toBe(STATUS_ESCALATED)
    expect(stateBackend.current.escalationMessage).toBe('Human needed')
  })

  it('goto_phase overrides the next phase via nextPhase signal', async () => {
    let call = 0
    await runWithStubExecutor(
      makeJob({ phase: 'alpha' }),
      ctx,
      async function* (_req, h) {
        call += 1
        if (call === 1) {
          h.signals.nextPhase = 'beta'
        }
        yield* yieldEmptyPhase(`goto-${call}`)
      },
      { workflowConfigOverride: workflowTwoPhase },
    )

    expect(call).toBe(2)
    expect(stateBackend.current.phase).toBe('beta')
    expect(stateBackend.current.status).toBe(STATUS_COMPLETE)
  })

  it('uses phase kickoff prompt (fresh on phase 1, continuation on phase 2)', async () => {
    const prompts: string[] = []
    const resumes: Array<string | undefined> = []
    let n = 0
    await runWithStubExecutor(
      makeJob({ phase: 'alpha' }),
      ctx,
      async function* (req) {
        n += 1
        prompts.push(req.userPrompt)
        resumes.push(req.sessionState?.sessionId)
        yield* yieldEmptyPhase(`sess-${n}`)
      },
      { workflowConfigOverride: workflowTwoPhase },
    )

    expect(prompts).toHaveLength(2)
    expect(resumes).toEqual([undefined, 'sess-1'])
    // Phase 1 has no sessionId yet — fresh kickoff.
    expect(prompts[0]).toContain('Begin phase')
    expect(prompts[0]).toContain('alpha')
    // Phase 2 resumes the session and uses the continuation kickoff.
    expect(prompts[1]).toContain('now in phase')
    expect(prompts[1]).toContain('beta')
  })

  it('re-registers dynamic MCP servers on resumed queries', async () => {
    const dynamicMcpServers = { a5: { type: 'sdk' as const, name: 'a5', instance: {} as never } }
    const liveQuery = {
      setMcpServers: vi.fn().mockResolvedValue({ added: ['a5'], removed: [], errors: {} }),
      mcpServerStatus: vi.fn().mockResolvedValue([{ name: 'a5', status: 'connected' }]),
      reconnectMcpServer: vi.fn().mockResolvedValue(undefined),
    }

    const result = await reattachDynamicMcpServers(
      liveQuery as never,
      dynamicMcpServers,
      'a5',
    )

    expect(liveQuery.setMcpServers).toHaveBeenCalledWith(dynamicMcpServers)
    expect(liveQuery.mcpServerStatus).toHaveBeenCalledTimes(1)
    expect(liveQuery.reconnectMcpServer).not.toHaveBeenCalled()
    expect(result.initialStatus).toBe('connected')
    expect(result.finalStatus).toBe('connected')
    expect(result.reconnected).toBe(false)
  })

  // ── Token usage & cost tracking ───────────────────────────────────────────

  it('creates PhaseUsage with computed cost when signal breaks stream before result event', async () => {
    // Only signal nextPhase on the first invocation; phase beta simply
    // completes. Without this guard the generator would keep setting
    // nextPhase='beta' when already on beta, looping forever.
    let call = 0
    await runWithStubExecutor(
      makeJob({ phase: 'alpha' }),
      ctx,
      async function* (_req, h) {
        call++
        if (call === 1) {
          // Cumulative usage snapshot mirroring what the executor emits
          // after the first assistant turn.
          yield {
            type: 'usage',
            tokens: {
              inputTokens: 1000,
              outputTokens: 200,
              cacheReadInputTokens: 500,
              cacheCreationInputTokens: 100,
            },
          }
          // Agent calls goto_phase — sets signal, stream breaks before
          // a `done` event would normally finalise the phase.
          h.signals.nextPhase = 'beta'
          yield { type: 'session_start', sessionId: 'sig-break' }
        } else {
          yield* yieldEmptyPhase('beta-done')
        }
      },
      { workflowConfigOverride: workflowTwoPhase },
    )

    // Phase alpha should have a PhaseUsage entry despite no result event
    const alphaUsage = stateBackend.current.phaseUsage.find(
      (p: { phase: string }) => p.phase === 'alpha',
    )
    expect(alphaUsage).toBeDefined()
    expect(alphaUsage!.inputTokens).toBe(1000)
    expect(alphaUsage!.outputTokens).toBe(200)
    expect(alphaUsage!.cacheReadInputTokens).toBe(500)
    expect(alphaUsage!.numTurns).toBe(1)
    // No SDK result event → cost is 0 (token counts are the authoritative metric)
    expect(alphaUsage!.costUsd).toBe(0)
    expect(alphaUsage!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('creates PhaseUsage from result event and uses SDK cost when provided', async () => {
    // Seed the mock state backend with phase='only' so `syncJob` patches
    // preserve the correct phase when the runner records PhaseUsage.
    stateBackend = createMockStateBackend(makeJob({ phase: 'only', status: 'queued' }))
    ctx = makeRunnerContext(stateBackend)

    await runWithStubExecutor(
      makeJob({ phase: 'only' }),
      ctx,
      async function* () {
        // Per-turn cumulative usage from the assistant turn.
        yield {
          type: 'usage',
          tokens: {
            inputTokens: 500,
            outputTokens: 100,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        }
        // Final cumulative usage with authoritative totals + cost,
        // mirroring how the executor maps a `result` event.
        yield {
          type: 'usage',
          tokens: {
            inputTokens: 2000,
            outputTokens: 500,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            totalCostUsd: 1.2345,
          },
        }
        yield {
          type: 'done',
          stopReason: 'end_turn',
          sessionState: { sessionId: 'res-ok' },
          metrics: { durationMs: 45000, durationApiMs: 30000, numTurns: 5 },
        }
      },
      { workflowConfigOverride: workflowSingle },
    )

    const onlyUsage = stateBackend.current.phaseUsage.find(
      (p: { phase: string }) => p.phase === 'only',
    )
    expect(onlyUsage).toBeDefined()
    // Should use result event's authoritative totals, not per-turn accumulation
    expect(onlyUsage!.inputTokens).toBe(2000)
    expect(onlyUsage!.outputTokens).toBe(500)
    // SDK-provided cost
    expect(onlyUsage!.costUsd).toBe(1.2345)
    expect(onlyUsage!.durationMs).toBe(45000)
    expect(onlyUsage!.durationApiMs).toBe(30000)
    expect(onlyUsage!.numTurns).toBe(5)
    // Job total should include phase cost
    expect(stateBackend.current.tokenUsage.totalCostUsd).toBe(1.2345)
  })

  it('uses a delta from cumulative SDK cost when resuming an existing session', async () => {
    stateBackend = createMockStateBackend(makeJob({
      phase: 'only',
      status: 'queued',
      sessionId: 'resume-phase-cost',
      tokenUsage: {
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        totalCostUsd: 1.99,
      },
      phaseUsage: [{
        phase: 'planning',
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUsd: 1.99,
        durationMs: 12_000,
        durationApiMs: 9_000,
        numTurns: 6,
        model: 'plan-model',
      }],
    }))
    ctx = makeRunnerContext(stateBackend)

    await runWithStubExecutor(
      makeJob({ phase: 'only', sessionId: 'resume-phase-cost' }),
      ctx,
      async function* () {
        yield {
          type: 'usage',
          tokens: {
            inputTokens: 1800,
            outputTokens: 450,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            totalCostUsd: 2.49,
          },
        }
        yield {
          type: 'done',
          stopReason: 'end_turn',
          sessionState: { sessionId: 'resume-phase-cost' },
          metrics: { durationMs: 10_000, durationApiMs: 8_000, numTurns: 2 },
        }
      },
      { workflowConfigOverride: workflowSingle },
    )

    const onlyUsage = stateBackend.current.phaseUsage.at(-1)
    expect(onlyUsage).toBeDefined()
    expect(onlyUsage!.phase).toBe('only')
    expect(onlyUsage!.costUsd).toBeCloseTo(0.5)
    expect(stateBackend.current.tokenUsage.totalCostUsd).toBeCloseTo(2.49)
  })

  it('does not re-book cumulative SDK cost when a resumed session returns zero new tokens', async () => {
    stateBackend = createMockStateBackend(makeJob({
      phase: 'only',
      status: 'queued',
      sessionId: 'resume-no-usage',
      tokenUsage: {
        inputTokens: 2100,
        outputTokens: 500,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        totalCostUsd: 1.99,
      },
      phaseUsage: [{
        phase: 'evaluation',
        inputTokens: 2100,
        outputTokens: 500,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUsd: 1.99,
        durationMs: 20_000,
        durationApiMs: 18_000,
        numTurns: 8,
        model: 'plan-model',
      }],
    }))
    ctx = makeRunnerContext(stateBackend)

    await runWithStubExecutor(
      makeJob({ phase: 'only', sessionId: 'resume-no-usage' }),
      ctx,
      async function* () {
        // The Anthropic executor surfaces an `is_error` result via a
        // log event before yielding the final usage / done.
        yield { type: 'log', level: 'error', message: '[error] Credits exhausted' }
        yield {
          type: 'usage',
          tokens: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            totalCostUsd: 1.99,
          },
        }
        yield {
          type: 'done',
          stopReason: 'error',
          sessionState: { sessionId: 'resume-no-usage' },
          metrics: { durationMs: 0, durationApiMs: 0, numTurns: 1 },
        }
      },
      { workflowConfigOverride: workflowSingle },
    )

    const onlyUsage = stateBackend.current.phaseUsage.at(-1)
    expect(onlyUsage).toBeDefined()
    expect(onlyUsage!.phase).toBe('only')
    expect(onlyUsage!.inputTokens).toBe(0)
    expect(onlyUsage!.outputTokens).toBe(0)
    expect(onlyUsage!.costUsd).toBe(0)
    expect(stateBackend.current.tokenUsage.totalCostUsd).toBe(1.99)
  })

  it('accumulates PhaseUsage entries across multiple phases', async () => {
    let call = 0
    await runWithStubExecutor(
      makeJob({ phase: 'alpha' }),
      ctx,
      async function* () {
        call++
        yield {
          type: 'usage',
          tokens: {
            inputTokens: call * 1000,
            outputTokens: call * 200,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        }
        yield* yieldEmptyPhase(`multi-${call}`)
      },
      { workflowConfigOverride: workflowTwoPhase },
    )

    // Both phases should have entries
    expect(stateBackend.current.phaseUsage).toHaveLength(2)
    expect(stateBackend.current.phaseUsage[0].phase).toBe('alpha')
    expect(stateBackend.current.phaseUsage[0].inputTokens).toBe(1000)
    expect(stateBackend.current.phaseUsage[1].phase).toBe('beta')
    expect(stateBackend.current.phaseUsage[1].inputTokens).toBe(2000)
    // Job totals should sum across both phases
    expect(stateBackend.current.tokenUsage.inputTokens).toBe(3000)
    expect(stateBackend.current.tokenUsage.outputTokens).toBe(600)
  })

  it('creates zero-cost PhaseUsage when phase has no assistant turns', async () => {
    // Seed the mock state backend with phase='only' to match the runJob arg.
    stateBackend = createMockStateBackend(makeJob({ phase: 'only', status: 'queued' }))
    ctx = makeRunnerContext(stateBackend)

    await runWithStubExecutor(
      makeJob({ phase: 'only' }),
      ctx,
      () => yieldEmptyPhase('no-turns'),
      { workflowConfigOverride: workflowSingle },
    )

    expect(stateBackend.current.phaseUsage).toHaveLength(1)
    expect(stateBackend.current.phaseUsage[0].phase).toBe('only')
    expect(stateBackend.current.phaseUsage[0].inputTokens).toBe(0)
    expect(stateBackend.current.phaseUsage[0].costUsd).toBe(0)
    expect(stateBackend.current.phaseUsage[0].numTurns).toBe(0)
  })
})
