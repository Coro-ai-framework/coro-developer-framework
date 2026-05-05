import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { reattachDynamicMcpServers, runJob, type RunnerContext, type QueryInvocation } from '../../src/jobs/runner'
import {
  STATUS_CANCELLED,
  JobType,
  STATUS_COMPLETE,
  STATUS_ESCALATED,
  STATUS_FAILED,
  STATUS_AWAITING_PR_MERGE,
  STATUS_AWAITING_PLAN_APPROVAL,
  STATUS_AWAITING_DEVELOPER_INPUT,
  emptyTokenUsage,
} from '../../src/jobs/types'
import type { Job } from '../../src/jobs/types'
import type { WorkflowConfig } from '../../src/workflow-parser'
import type { Settings } from '../../src/config/settings'
import { PluginRegistry } from '../../src/plugins/registry'
import type { ScmPluginRuntime } from '../../src/plugins'

vi.mock('../../src/prompt/builder', () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue('# Mock system prompt for runner tests'),
  computeScmPromptContext: vi.fn().mockReturnValue({ available: true, resolved: 'github', installed: ['github'] }),
  // The runner now calls this once per phase to assemble the tracker block
  // before delegating to `buildSystemPrompt`. We mock it as a no-op pure
  // function so the runner's call site stays exercised without forcing
  // every test to wire up a real Settings + TrackerClient pair.
  computeTrackerPromptContext: vi.fn().mockReturnValue({ provider: 'none', available: false }),
}))

vi.mock('../../src/claude-code-path', () => ({
  resolveClaudeCodeCliPath: vi.fn().mockReturnValue('/tmp/mock-claude-cli.js'),
  ensureClaudeCodeCliExecutable: vi.fn(),
}))

function makeSettings(): Settings {
  return {
    host: { port: 3000, webhookSecret: 's', logLevel: 'silent' },
    claude: {
      auth: { method: 'apiKey', apiKey: 'k' },
      planningModel: 'plan-model',
      codingModel: 'code-model',
    },
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
  let hooks: Record<string, Array<{ hooks: Array<(input: Record<string, unknown>) => Promise<unknown>> }>> | undefined

  await runJob(makeJob({ phase: 'only', status: 'queued' }), ctx, {
    queryImpl: (inv) =>
      (async function* () {
        hooks = inv.options['hooks'] as typeof hooks
        yield { type: 'system', session_id: 'hook-capture' }
      })(),
    workflowConfigOverride: workflowConfig,
  })

  const preToolUse = hooks?.PreToolUse?.[0]?.hooks?.[0]
  if (!preToolUse) {
    throw new Error('PreToolUse hook was not attached to the query options')
  }
  return preToolUse
}

describe('runJob (mocked Agent SDK query)', () => {
  let stateBackend: MockStateBackend
  let ctx: RunnerContext

  beforeEach(() => {
    stateBackend = createMockStateBackend(makeJob({ phase: 'alpha', status: 'queued' }))
    ctx = makeRunnerContext(stateBackend)
  })

  it('completes a single-phase workflow when the stream ends', async () => {
    const queryImpl = () =>
      (async function* () {
        yield { type: 'system', session_id: 'sess-single' }
      })()

    await runJob(makeJob({ phase: 'only' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowSingle,
    })

    expect(stateBackend.current.status).toBe(STATUS_COMPLETE)
    expect(stateBackend.updateJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sessionId: 'sess-single' }),
    )
  })

  it('advances phases then completes', async () => {
    let call = 0
    const queryImpl = () =>
      (async function* () {
        call += 1
        yield { type: 'system', session_id: `sess-${call}` }
      })()

    await runJob(makeJob({ phase: 'alpha' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowTwoPhase,
    })

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

    expect(stateBackend.current.status).toBe(STATUS_AWAITING_PR_MERGE)
    expect(stateBackend.current.awaitingEvent).toBe('pr:merged')
    expect(stateBackend.current.awaitingPrId).toBe(99)
  })

  it('parks with awaiting-developer-input when event name starts with "developer-input"', async () => {
    const queryImpl = (inv: QueryInvocation) =>
      (async function* () {
        inv.signals.awaitingEvent = 'developer-input: unclear if X should be idempotent'
        yield { type: 'system' }
      })()

    await runJob(makeJob({ phase: 'alpha' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowTwoPhase,
    })

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

    const queryImpl = () =>
      (async function* () {
        yield { type: 'system', session_id: 'sess-cp' }
      })()

    await runJob(makeJob({ phase: 'alpha', interactive: true }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowCheckpoint,
    })

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

    const queryImpl = (inv: QueryInvocation) =>
      (async function* () {
        inv.signals.awaitingEvent = 'developer-input: Approve implementation plan for alpha'
        yield { type: 'system', session_id: 'sess-agent-approval' }
      })()

    await runJob(makeJob({ phase: 'alpha', interactive: true }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowCheckpoint,
    })

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
        status: STATUS_AWAITING_DEVELOPER_INPUT,
        interactive: true,
        approvedAdvanceFromPhase: 'alpha',
      }),
    )
    ctx = makeRunnerContext(stateBackend)

    let call = 0
    const queryImpl = () =>
      (async function* () {
        call += 1
        yield { type: 'system', session_id: `sess-approved-${call}` }
      })()

    await runJob(makeJob({ phase: 'alpha', interactive: true, approvedAdvanceFromPhase: 'alpha' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowCheckpoint,
    })

    expect(call).toBe(2)
    expect(stateBackend.current.status).toBe(STATUS_COMPLETE)
    expect(stateBackend.current.phase).toBe('beta')
    expect(stateBackend.current.approvedAdvanceFromPhase).toBeUndefined()
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

    expect(stateBackend.current.status).toBe(STATUS_AWAITING_PLAN_APPROVAL)
  })

  it('auto-advances when query ends without any signal (no escalation)', async () => {
    let call = 0
    const queryImpl = () =>
      (async function* () {
        call += 1
        yield { type: 'system', session_id: `auto-${call}` }
      })()

    await runJob(makeJob({ phase: 'alpha' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowTwoPhase,
    })

    expect(call).toBe(2)
    expect(stateBackend.current.status).toBe(STATUS_COMPLETE)
    expect(stateBackend.current.phase).toBe('beta')
  })

  it('stops at a safe boundary when the job is cancelled during the live turn', async () => {
    const queryImpl = () =>
      (async function* () {
        await stateBackend.updateJob('runner-job-1', { ...cancellationPatch, phase: 'only' })
        yield { type: 'system', session_id: 'sess-cancelled' }
      })()

    await runJob(makeJob({ phase: 'only' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowSingle,
    })

    expect(stateBackend.current.status).toBe(STATUS_CANCELLED)
    expect(stateBackend.current.phase).toBe('only')
    expect(stateBackend.appendLog).not.toHaveBeenCalledWith(
      'runner-job-1',
      expect.stringContaining('All phases complete'),
    )
  })

  it('does not park a cancelled job even if the agent already requested await_event', async () => {
    const queryImpl = (inv: QueryInvocation) =>
      (async function* () {
        await stateBackend.updateJob('runner-job-1', cancellationPatch)
        inv.signals.awaitingEvent = 'pr:merged'
        inv.signals.awaitingPrId = 99
        yield { type: 'system', session_id: 'sess-cancelled-await' }
      })()

    await runJob(makeJob({ phase: 'alpha' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowTwoPhase,
    })

    expect(stateBackend.current.status).toBe(STATUS_CANCELLED)
    expect(stateBackend.current.awaitingEvent).toBeUndefined()
    expect(stateBackend.current.awaitingPrId).toBeUndefined()
  })

  it('does not overwrite a cancelled job with failed when the active turn crashes', async () => {
    const queryImpl = () =>
      (async function* () {
        await stateBackend.updateJob('runner-job-1', cancellationPatch)
        throw new Error('query crashed after cancel')
      })()

    await runJob(makeJob({ phase: 'only' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowSingle,
    })

    expect(stateBackend.current.status).toBe(STATUS_CANCELLED)
    expect(stateBackend.updateJob).not.toHaveBeenCalledWith(
      'runner-job-1',
      expect.objectContaining({ status: STATUS_FAILED }),
    )
  })

  it('persists sessionId from system messages', async () => {
    const queryImpl = () =>
      (async function* () {
        yield { type: 'system', session_id: 'persist-me' }
      })()

    await runJob(makeJob({ phase: 'only' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowSingle,
    })

    expect(stateBackend.current.sessionId).toBe('persist-me')
  })

  it('logs assistant text from BetaMessage content blocks', async () => {
    const queryImpl = () =>
      (async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Hello from the assistant' }] },
          session_id: 'x',
        }
        yield { type: 'system', session_id: 'x' }
      })()

    await runJob(makeJob({ phase: 'only' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowSingle,
    })

    expect(stateBackend.appendLog).toHaveBeenCalledWith('runner-job-1', 'Hello from the assistant')
  })

  it('logs tool_use blocks from assistant message', async () => {
    const queryImpl = () =>
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'Read', input: { path: '/tmp/foo' } }],
          },
          session_id: 'x',
        }
        yield { type: 'system', session_id: 'x' }
      })()

    await runJob(makeJob({ phase: 'only' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowSingle,
    })

    expect(stateBackend.appendLog).toHaveBeenCalledWith(
      'runner-job-1',
      expect.stringContaining('→ Read'),
    )
  })

  it('logs tool_use_summary with summary text', async () => {
    const queryImpl = () =>
      (async function* () {
        yield { type: 'tool_use_summary', summary: 'Read 3 files in src/' }
        yield { type: 'system', session_id: 'x' }
      })()

    await runJob(makeJob({ phase: 'only' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowSingle,
    })

    expect(stateBackend.appendLog).toHaveBeenCalledWith(
      'runner-job-1',
      '[tool_summary] Read 3 files in src/',
    )
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

    expect(stateBackend.current.status).toBe(STATUS_FAILED)
    expect(stateBackend.current.escalationMessage).toContain('SDK exploded')
    expect(ctx.logger.error).toHaveBeenCalled()
  })

  it('warns but still auto-advances when built-in tools ran but no A5 MCP tool was used', async () => {
    const queryImpl = () =>
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status' } }],
          },
        }
        yield { type: 'system', session_id: 'missing-mcp' }
      })()

    await runJob(makeJob({ phase: 'alpha' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowTwoPhase,
    })

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
        permissionDecisionReason: expect.stringContaining('parent-directory traversal'),
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

    let capturedAgents: Record<string, unknown> | undefined
    const queryImpl = (inv: QueryInvocation) =>
      (async function* () {
        capturedAgents = inv.options['agents'] as Record<string, unknown>
        yield { type: 'system', session_id: 'subagent-tools' }
      })()

    await runJob(makeJob({ phase: 'only' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowWithSubagent,
    })

    expect(capturedAgents).toMatchObject({
      reviewer: {
        tools: ['Read', 'Bash', 'mcp__coro__log'],
      },
    })
  })

  it('stops when escalated signal is set (after stateBackend update)', async () => {
    const queryImpl = async function* (inv: QueryInvocation) {
      await inv.toolCtx.stateBackend.updateJob(inv.toolCtx.job.id, {
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

    expect(stateBackend.current.status).toBe(STATUS_ESCALATED)
    expect(stateBackend.current.escalationMessage).toBe('Human needed')
  })

  it('goto_phase overrides the next phase via nextPhase signal', async () => {
    let call = 0
    const queryImpl = (inv: QueryInvocation) =>
      (async function* () {
        call += 1
        if (call === 1) {
          inv.signals.nextPhase = 'beta'
        }
        yield { type: 'system', session_id: `goto-${call}` }
      })()

    await runJob(makeJob({ phase: 'alpha' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowTwoPhase,
    })

    expect(call).toBe(2)
    expect(stateBackend.current.phase).toBe('beta')
    expect(stateBackend.current.status).toBe(STATUS_COMPLETE)
  })

  it('uses phase kickoff prompt (fresh on phase 1, continuation on phase 2)', async () => {
    const prompts: string[] = []
    const resumes: Array<string | undefined> = []
    let n = 0
    const queryImpl = (inv: QueryInvocation) =>
      (async function* () {
        n += 1
        prompts.push(inv.prompt)
        resumes.push(inv.options['resume'] as string | undefined)
        yield { type: 'system', session_id: `sess-${n}` }
      })()

    await runJob(makeJob({ phase: 'alpha' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowTwoPhase,
    })

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
    const queryImpl = (inv: QueryInvocation) =>
      (async function* () {
        call++
        if (call === 1) {
          yield {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: 'Working...' }],
              usage: {
                input_tokens: 1000,
                output_tokens: 200,
                cache_read_input_tokens: 500,
                cache_creation_input_tokens: 100,
              },
            },
          }
          // Agent calls goto_phase — sets signal, stream breaks before result event
          inv.signals.nextPhase = 'beta'
          yield { type: 'system', session_id: 'sig-break' }
        } else {
          yield { type: 'system', session_id: 'beta-done' }
        }
      })()

    await runJob(makeJob({ phase: 'alpha' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowTwoPhase,
    })

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

    const queryImpl = () =>
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Done' }],
            usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        }
        // Result event with authoritative totals
        yield {
          type: 'result',
          result: 'Phase complete',
          usage: { input_tokens: 2000, output_tokens: 500 },
          total_cost_usd: 1.2345,
          duration_ms: 45000,
          duration_api_ms: 30000,
          num_turns: 5,
        }
        yield { type: 'system', session_id: 'res-ok' }
      })()

    await runJob(makeJob({ phase: 'only' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowSingle,
    })

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

  it('accumulates PhaseUsage entries across multiple phases', async () => {
    let call = 0
    const queryImpl = () =>
      (async function* () {
        call++
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: `Phase ${call}` }],
            usage: {
              input_tokens: call * 1000,
              output_tokens: call * 200,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        }
        yield { type: 'system', session_id: `multi-${call}` }
      })()

    await runJob(makeJob({ phase: 'alpha' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowTwoPhase,
    })

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

    const queryImpl = () =>
      (async function* () {
        yield { type: 'system', session_id: 'no-turns' }
      })()

    await runJob(makeJob({ phase: 'only' }), ctx, {
      queryImpl,
      workflowConfigOverride: workflowSingle,
    })

    expect(stateBackend.current.phaseUsage).toHaveLength(1)
    expect(stateBackend.current.phaseUsage[0].phase).toBe('only')
    expect(stateBackend.current.phaseUsage[0].inputTokens).toBe(0)
    expect(stateBackend.current.phaseUsage[0].costUsd).toBe(0)
    expect(stateBackend.current.phaseUsage[0].numTurns).toBe(0)
  })
})
