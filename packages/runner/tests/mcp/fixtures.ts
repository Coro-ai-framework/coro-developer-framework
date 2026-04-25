import { vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import { JobType, STATUS_QUEUED, emptyTokenUsage } from '../../src/jobs/types'
import type { ToolContext } from '../../src/tools/types'
import type { BitBucketClient } from '../../src/clients/bitbucket'
import type { LokiClient } from '../../src/clients/loki'
import type { TempoClient } from '../../src/clients/tempo'
import type { JiraClient } from '../../src/clients/jira'
import type { StateBackend } from '../../src/state/backend'

export function makeMockJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-mcp-test',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: { repoSlug: 'svc', reviewers: ['reviewer-1'] },
    triggerSource: 'cli' as const,
    status: STATUS_QUEUED,
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

export function makeMockToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const bbCoder = {
    createRepo: vi.fn().mockResolvedValue({ full_name: 'ws/new-repo' }),
    createPr: vi.fn().mockResolvedValue({
      id: 99,
      links: { html: { href: 'https://bb/pr/99' } },
      state: 'OPEN',
    }),
    getPrStatus: vi.fn().mockResolvedValue({ state: 'OPEN', approvals: 1 }),
  } as unknown as BitBucketClient

  const bbReviewer = {
    getComments: vi.fn().mockResolvedValue([
      {
        id: 1,
        content: { raw: 'hello' },
        created_on: '2026-01-01T00:00:00Z',
        parent: undefined,
        inline: undefined,
      },
    ]),
    postComment: vi.fn().mockResolvedValue({ id: 2 }),
    replyToComment: vi.fn().mockResolvedValue({ id: 3 }),
    approvePr: vi.fn().mockResolvedValue(undefined),
    mergePr: vi.fn().mockResolvedValue({ state: 'MERGED' }),
  } as unknown as BitBucketClient

  const stateBackend = {
    getJob: vi.fn().mockImplementation(async () => makeMockJob()),
    updateJob: vi.fn().mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeMockJob(),
      ...patch,
    })),
    appendLog: vi.fn().mockResolvedValue(undefined),
    addPrMapping: vi.fn().mockImplementation(async (_id: string, mapping: Record<string, unknown>) => ({
      ...makeMockJob(),
      prMappings: [mapping],
    })),
    mapPrToJob: vi.fn().mockResolvedValue(undefined),
  } as unknown as StateBackend

  const lokiClient = {
    query: vi.fn().mockResolvedValue({ streams: [] }),
  } as unknown as LokiClient

  const tempoClient = {
    getTrace: vi.fn().mockResolvedValue({ traceId: 'abc' }),
    search: vi.fn().mockResolvedValue({ traces: [] }),
  } as unknown as TempoClient

  const jiraClient = {
    getIssue: vi.fn().mockResolvedValue({ key: 'X-1', fields: {} }),
    postComment: vi.fn().mockResolvedValue({ id: 'c1' }),
    transitionIssue: vi.fn().mockResolvedValue(null),
  } as unknown as JiraClient

  return {
    job: makeMockJob(),
    stateBackend,
    settings: {
      paths: { coroIntelligenceDir: '/tmp/coro-mcp-test', workingDir: '/tmp/work-mcp' },
    } as ToolContext['settings'],
    tenantContext: {
      tenantId: 'solo-test-host',
      mode: 'solo' as const,
      displayName: 'Solo (test-host)',
      overlay: { kind: 'none' as const },
    },
    jobIntelligenceDir: '/tmp/coro-mcp-test',
    gitClient: {} as ToolContext['gitClient'],
    bbCoder,
    bbReviewer,
    ghClient: null,
    ghGitClient: null,
    lokiClient,
    tempoClient,
    jiraClient,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as ToolContext['logger'],
    runningServices: new Map<string, ChildProcess>(),
    ...overrides,
  }
}
