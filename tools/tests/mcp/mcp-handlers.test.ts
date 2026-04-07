import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import * as cp from 'child_process'
import { createMcpToolHandlers, mcpText, mcpError } from '../../src/mcp-handlers'
import { STATUS_ESCALATED } from '../../src/jobs/types'
import type { ToolContext } from '../../src/tools/types'
import { makeMockToolContext, makeMockJob } from './fixtures'

vi.mock('fs/promises')

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: vi.fn(),
  }
})

const mockFs = vi.mocked(fs)

/** Parses JSON from the first text content block returned by handlers. */
function parseJson(result: { content: Array<{ type: string; text: string }> }): unknown {
  const raw = result.content[0]?.text
  if (raw === undefined) throw new Error('expected text content')
  return JSON.parse(raw)
}

describe('mcpText / mcpError', () => {
  it('mcpText stringifies data as formatted JSON', () => {
    const r = mcpText({ a: 1 })
    expect(r.content[0].type).toBe('text')
    expect(JSON.parse(r.content[0].text)).toEqual({ a: 1 })
  })

  it('mcpError marks isError and passes message as text', () => {
    const r = mcpError('bad')
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe('bad')
  })
})

describe('createMcpToolHandlers — job control & signals', () => {
  let ctx: ReturnType<typeof makeMockToolContext>
  let signals: import('../../src/tools/types').PhaseSignals

  beforeEach(() => {
    ctx = makeMockToolContext()
    signals = {}
  })

  it('mark_phase_complete sets phaseComplete hint', async () => {
    const h = createMcpToolHandlers(ctx, signals)
    const out = parseJson(await h.mark_phase_complete()) as Record<string, unknown>
    expect(signals.phaseComplete).toBe(true)
    expect(out).toEqual({ acknowledged: true })
  })

  it('await_event sets awaitingEvent and optional awaitingPrId', async () => {
    const h = createMcpToolHandlers(ctx, signals)
    await h.await_event({ eventName: 'pr:merged', prId: 7 })
    expect(signals.awaitingEvent).toBe('pr:merged')
    expect(signals.awaitingPrId).toBe(7)

    await h.await_event({ eventName: 'comment' })
    expect(signals.awaitingEvent).toBe('comment')
    expect(signals.awaitingPrId).toBeUndefined()
  })

  it('escalate updates job in registry and sets signals', async () => {
    const h = createMcpToolHandlers(ctx, signals)
    const out = parseJson(await h.escalate({ reason: 'Blocked on auth' })) as Record<string, unknown>

    expect(ctx.registry.updateJob).toHaveBeenCalledWith('job-mcp-test', {
      status: STATUS_ESCALATED,
      escalationMessage: 'Blocked on auth',
    })
    expect(signals.escalated).toBe(true)
    expect(signals.escalationReason).toBe('Blocked on auth')
    expect(ctx.logger.warn).toHaveBeenCalled()
    expect(out['escalated']).toBe(true)
  })

  it('log appends to registry', async () => {
    const h = createMcpToolHandlers(ctx, signals)
    await h.log({ message: 'Step done' })
    expect(ctx.registry.appendLog).toHaveBeenCalledWith('job-mcp-test', 'Step done')
  })
})

describe('createMcpToolHandlers — BitBucket (coder)', () => {
  let ctx: ReturnType<typeof makeMockToolContext>

  beforeEach(() => {
    ctx = makeMockToolContext()
  })

  it('bb_create_repo creates a private repo', async () => {
    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.bb_create_repo({ repoSlug: 'my-svc', description: 'svc' })) as Record<
      string,
      unknown
    >
    expect(ctx.bbCoder.createRepo).toHaveBeenCalledWith({
      repoSlug: 'my-svc',
      description: 'svc',
      isPrivate: true,
    })
    expect(data['fullName']).toBe('ws/new-repo')
  })

  it('bb_create_pr passes job reviewers when reviewers omitted', async () => {
    const h = createMcpToolHandlers(ctx, {})
    await h.bb_create_pr({
      repoSlug: 'r',
      title: 'T',
      sourceBranch: 'feat',
    })
    expect(ctx.bbCoder.createPr).toHaveBeenCalledWith(
      expect.objectContaining({
        repoSlug: 'r',
        reviewerUsernames: ['reviewer-1'],
        targetBranch: 'main',
      }),
    )
  })

  it('bb_create_pr uses explicit reviewers when provided', async () => {
    const h = createMcpToolHandlers(ctx, {})
    await h.bb_create_pr({
      repoSlug: 'r',
      title: 'T',
      sourceBranch: 'feat',
      reviewerUsernames: ['alice'],
    })
    expect(ctx.bbCoder.createPr).toHaveBeenCalledWith(
      expect.objectContaining({ reviewerUsernames: ['alice'] }),
    )
  })

  it('bb_get_pr_status returns status payload', async () => {
    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.bb_get_pr_status({ repoSlug: 'r', prId: 1 }))
    expect(ctx.bbCoder.getPrStatus).toHaveBeenCalledWith('r', 1)
    expect(data).toEqual({ state: 'OPEN', approvals: 1 })
  })
})

describe('createMcpToolHandlers — BitBucket (reviewer)', () => {
  let ctx: ReturnType<typeof makeMockToolContext>

  beforeEach(() => {
    ctx = makeMockToolContext()
  })

  it('bb_get_pr_comments maps comment shape', async () => {
    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.bb_get_pr_comments({ repoSlug: 'r', prId: 1 })) as unknown[]
    expect(Array.isArray(data)).toBe(true)
    expect(data[0]).toMatchObject({
      id: 1,
      content: 'hello',
      parentId: null,
    })
  })

  it('bb_post_pr_comment, bb_reply_to_comment, bb_approve_pr, bb_merge_pr delegate to reviewer', async () => {
    const h = createMcpToolHandlers(ctx, {})

    await h.bb_post_pr_comment({ repoSlug: 'r', prId: 1, content: 'hi' })
    expect(ctx.bbReviewer.postComment).toHaveBeenCalledWith('r', 1, 'hi')

    await h.bb_reply_to_comment({ repoSlug: 'r', prId: 1, parentId: 9, content: 'reply' })
    expect(ctx.bbReviewer.replyToComment).toHaveBeenCalledWith('r', 1, 9, 'reply')

    await h.bb_approve_pr({ repoSlug: 'r', prId: 2 })
    expect(ctx.bbReviewer.approvePr).toHaveBeenCalledWith('r', 2)

    await h.bb_merge_pr({ repoSlug: 'r', prId: 2, message: 'merge' })
    expect(ctx.bbReviewer.mergePr).toHaveBeenCalledWith('r', 2, 'merge')
  })
})

describe('createMcpToolHandlers — observability & Jira', () => {
  let ctx: ReturnType<typeof makeMockToolContext>

  beforeEach(() => {
    ctx = makeMockToolContext()
  })

  it('forwards loki_query, tempo_get_trace, tempo_search', async () => {
    const h = createMcpToolHandlers(ctx, {})

    await h.loki_query({ logQL: '{job="x"}', start: '2026-01-01', end: 'now', limit: 100 })
    expect(ctx.lokiClient.query).toHaveBeenCalledWith('{job="x"}', '2026-01-01', 'now', 100)

    await h.tempo_get_trace({ traceId: 'tid' })
    expect(ctx.tempoClient.getTrace).toHaveBeenCalledWith('tid')

    await h.tempo_search({ query: '{}', start: 's', end: 'e', limit: 5 })
    expect(ctx.tempoClient.search).toHaveBeenCalledWith('{}', 's', 'e', 5)
  })

  it('forwards Jira calls', async () => {
    const h = createMcpToolHandlers(ctx, {})

    await h.jira_get_issue({ ticketId: 'ABC-1' })
    expect(ctx.jiraClient.getIssue).toHaveBeenCalledWith('ABC-1')

    await h.jira_post_comment({ ticketId: 'ABC-1', body: 'note' })
    expect(ctx.jiraClient.postComment).toHaveBeenCalledWith('ABC-1', 'note')

    const tr = parseJson(await h.jira_transition_issue({ ticketId: 'ABC-1', transitionId: '31' }))
    expect(ctx.jiraClient.transitionIssue).toHaveBeenCalledWith('ABC-1', '31')
    expect(tr).toEqual({ transitioned: true })
  })
})

describe('createMcpToolHandlers — compare_request', () => {
  let ctx: ReturnType<typeof makeMockToolContext>
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    ctx = makeMockToolContext()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('reports match when both bodies normalize to same JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => '{"a":1}',
    }) as unknown as typeof fetch

    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(
      await h.compare_request({
        goBaseUrl: 'http://go',
        dotnetBaseUrl: 'http://net',
        method: 'GET',
        path: '/x',
      }),
    ) as Record<string, unknown>

    expect(data['match']).toBe(true)
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  it('reports no match when status differs', async () => {
    let n = 0
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      n += 1
      return {
        status: n === 1 ? 200 : 500,
        text: async () => '{}',
      }
    }) as unknown as typeof fetch

    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(
      await h.compare_request({
        goBaseUrl: 'http://go',
        dotnetBaseUrl: 'http://net',
        method: 'GET',
        path: '/',
      }),
    ) as Record<string, unknown>

    expect(data['match']).toBe(false)
  })
})

describe('createMcpToolHandlers — run_go_build', () => {
  let ctx: ReturnType<typeof makeMockToolContext>

  beforeEach(() => {
    ctx = makeMockToolContext()
  })

  it('returns error result when go build fails (invalid module path)', async () => {
    const h = createMcpToolHandlers(ctx, {})
    const result = await h.run_go_build({ repoDir: '/nonexistent-dir-for-go-build-test-xyz' })
    expect('isError' in result && result.isError).toBe(true)
  })
})

describe('createMcpToolHandlers — start_go_service / stop_go_service', () => {
  let ctx: ReturnType<typeof makeMockToolContext>
  const spawnMock = vi.mocked(cp.spawn)

  beforeEach(() => {
    ctx = makeMockToolContext()
    vi.useFakeTimers()
    spawnMock.mockReturnValue({
      pid: 111,
      on: vi.fn(),
      kill: vi.fn(),
    } as never)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects duplicate label', async () => {
    const h = createMcpToolHandlers(ctx, {})

    const p = h.start_go_service({
      label: 'svc',
      repoDir: '/tmp',
      binaryName: 'app',
      port: 3000,
    })
    await vi.advanceTimersByTimeAsync(1600)
    await p

    const again = h.start_go_service({
      label: 'svc',
      repoDir: '/tmp',
      binaryName: 'app',
      port: 3001,
    })
    await vi.advanceTimersByTimeAsync(1600)
    const second = await again

    expect('isError' in second && second.isError).toBe(true)
  })

  it('stop_go_service kills process and clears label', async () => {
    const h = createMcpToolHandlers(ctx, {})
    const kill = vi.fn()
    const fake = { pid: 222, on: vi.fn(), kill }
    ctx.runningServices.set('x', fake as never)

    const data = parseJson(await h.stop_go_service({ label: 'x' })) as Record<string, unknown>
    expect(kill).toHaveBeenCalledWith('SIGTERM')
    expect(ctx.runningServices.has('x')).toBe(false)
    expect(data['stopped']).toBe('x')
  })

  it('stop_go_service errors when label unknown', async () => {
    const h = createMcpToolHandlers(ctx, {})
    const r = await h.stop_go_service({ label: 'nope' })
    expect('isError' in r && r.isError).toBe(true)
  })
})

describe('createMcpToolHandlers — feature tracking', () => {
  let ctx: ReturnType<typeof makeMockToolContext>

  beforeEach(() => {
    ctx = makeMockToolContext()
  })

  it('set_features registers features with pending status and loopCount 0', async () => {
    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.set_features({ features: ['scaffold', 'users-api'] })) as Record<string, unknown>

    expect(data['registered']).toBe(2)
    expect(ctx.registry.updateJob).toHaveBeenCalledWith('job-mcp-test', {
      features: [
        { name: 'scaffold', status: 'pending', loopCount: 0 },
        { name: 'users-api', status: 'pending', loopCount: 0 },
      ],
    })
  })

  it('get_features returns features and currentFeature from job', async () => {
    const jobWithFeatures = makeMockJob({
      features: [{ name: 'f1', status: 'complete', loopCount: 1 }],
      currentFeature: 'f1',
    })
    ;(ctx.registry.getJob as ReturnType<typeof vi.fn>).mockResolvedValue(jobWithFeatures)

    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.get_features()) as Record<string, unknown>
    expect(data['currentFeature']).toBe('f1')
    expect((data['features'] as unknown[]).length).toBe(1)
  })

  it('update_feature updates status and sets currentFeature when in-progress', async () => {
    const jobWithFeatures = makeMockJob({
      features: [
        { name: 'f1', status: 'pending', loopCount: 0 },
        { name: 'f2', status: 'pending', loopCount: 0 },
      ],
    })
    ;(ctx.registry.getJob as ReturnType<typeof vi.fn>).mockResolvedValue(jobWithFeatures)

    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.update_feature({ name: 'f1', status: 'in-progress' })) as Record<string, unknown>

    expect(data['updated']).toBe('f1')
    expect(data['status']).toBe('in-progress')
    expect(ctx.registry.updateJob).toHaveBeenCalledWith(
      'job-mcp-test',
      expect.objectContaining({ currentFeature: 'f1' }),
    )
  })

  it('update_feature increments loop count', async () => {
    const jobWithFeatures = makeMockJob({
      features: [{ name: 'f1', status: 'in-progress', loopCount: 2 }],
    })
    ;(ctx.registry.getJob as ReturnType<typeof vi.fn>).mockResolvedValue(jobWithFeatures)

    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.update_feature({ name: 'f1', incrementLoop: true })) as Record<string, unknown>

    expect(data['loopCount']).toBe(3)
  })

  it('request_new_session clears sessionId and logs reason', async () => {
    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.request_new_session({ reason: 'Starting next feature' })) as Record<string, unknown>

    expect(data['newSession']).toBe(true)
    expect(ctx.registry.updateJob).toHaveBeenCalledWith('job-mcp-test', { sessionId: undefined })
    expect(ctx.registry.appendLog).toHaveBeenCalledWith('job-mcp-test', '[session-reset] Starting next feature')
  })

  it('set_job_params merges params into job', async () => {
    const jobWithParams = makeMockJob({ params: { repoSlug: 'svc', reviewers: ['r'] } })
    ;(ctx.registry.getJob as ReturnType<typeof vi.fn>).mockResolvedValue(jobWithParams)

    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.set_job_params({ params: { language: 'golang' } })) as Record<string, unknown>

    expect(data['updated']).toEqual(['language'])
    expect(ctx.registry.updateJob).toHaveBeenCalledWith(
      'job-mcp-test',
      expect.objectContaining({ params: { repoSlug: 'svc', reviewers: ['r'], language: 'golang' } }),
    )
  })
})

describe('createMcpToolHandlers — add_insight', () => {
  let ctx: ReturnType<typeof makeMockToolContext>

  beforeEach(() => {
    ctx = makeMockToolContext()
  })

  it('appends insight to job and logs it', async () => {
    const jobWithInsights = makeMockJob({ insights: [{ phase: 'planning', category: 'old', summary: 'x', detail: 'y' }] })
    ;(ctx.registry.getJob as ReturnType<typeof vi.fn>).mockResolvedValue(jobWithInsights)

    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.add_insight({
      category: 'auth',
      summary: 'x-token-auth returns 401',
      detail: 'Used Basic auth with encoded username instead',
      suggestion: 'Update memory with working auth pattern',
    })) as Record<string, unknown>

    expect(data['recorded']).toBe(true)
    expect(data['totalInsights']).toBe(2)

    expect(ctx.registry.updateJob).toHaveBeenCalledWith(
      'job-mcp-test',
      expect.objectContaining({
        insights: expect.arrayContaining([
          expect.objectContaining({ category: 'auth', summary: 'x-token-auth returns 401', phase: 'coding' }),
        ]),
      }),
    )

    expect(ctx.registry.appendLog).toHaveBeenCalledWith(
      'job-mcp-test',
      '[insight] auth: x-token-auth returns 401',
    )
  })

  it('works with empty initial insights', async () => {
    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.add_insight({
      category: 'tooling',
      summary: 'npm ci faster than npm install',
      detail: 'Saves 30s on restore',
    })) as Record<string, unknown>

    expect(data['recorded']).toBe(true)
    expect(data['totalInsights']).toBe(1)
  })
})

describe('createMcpToolHandlers — propose_change / list_proposals', () => {
  let ctx: ReturnType<typeof makeMockToolContext>

  beforeEach(() => {
    vi.clearAllMocks()
    mockFs.mkdir.mockResolvedValue(undefined)
    mockFs.writeFile.mockResolvedValue(undefined)
    mockFs.readdir.mockResolvedValue([] as never)
    mockFs.readFile.mockResolvedValue('')

    ctx = makeMockToolContext({
      job: makeMockJob({ id: 'proposal-job' }),
      settings: { paths: { a5aiDir: '/data/a5ai', workingDir: '/tmp/w' } } as ToolContext['settings'],
    })
  })

  it('propose_change writes proposal via self-improvement module', async () => {
    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(
      await h.propose_change({
        type: 'memory-update',
        title: 'Add note',
        rationale: 'because',
        description: 'details',
        files: [{ path: 'memory/x.md', content: '# X' }],
      }),
    ) as Record<string, unknown>

    expect(data['fileCount']).toBe(1)
    expect(mockFs.writeFile).toHaveBeenCalled()
  })

  it('list_proposals returns empty when directory missing', async () => {
    mockFs.readdir.mockRejectedValueOnce(new Error('ENOENT'))
    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.list_proposals({})) as Record<string, unknown>
    expect(data['proposals']).toEqual([])
    expect(data['count']).toBe(0)
  })
})
