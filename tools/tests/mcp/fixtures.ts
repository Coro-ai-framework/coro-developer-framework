import { vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import { JobType, STATUS_QUEUED } from '../../src/jobs/types'
import type { ToolContext } from '../../src/tools/types'
import type { BitBucketClient } from '../../src/clients/bitbucket'
import type { LokiClient } from '../../src/clients/loki'
import type { TempoClient } from '../../src/clients/tempo'
import type { JiraClient } from '../../src/clients/jira'
import type { JobRegistry } from '../../src/jobs/registry'

export function makeMockJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-mcp-test',
    type: JobType.Migration,
    workflowPath: 'workflows/migration/workflow.md',
    params: { repoSlug: 'svc', reviewers: ['reviewer-1'] },
    triggerSource: 'cli' as const,
    status: STATUS_QUEUED,
    phase: 'coding',
    currentFeature: null,
    prMappings: [],
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

  const registry = {
    updateJob: vi.fn().mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeMockJob(),
      ...patch,
    })),
    appendLog: vi.fn().mockResolvedValue(undefined),
  } as unknown as JobRegistry

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
    registry,
    settings: {
      paths: { a5aiDir: '/tmp/a5ai-mcp-test', workingDir: '/tmp/work-mcp' },
    } as ToolContext['settings'],
    gitClient: {} as ToolContext['gitClient'],
    bbCoder,
    bbReviewer,
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
