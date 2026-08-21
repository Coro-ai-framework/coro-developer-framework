import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import { simpleGit } from 'simple-git'
import { createMcpToolHandlers, mcpText, mcpError } from '../../src/mcp-handlers'
import { installRepoGitAuth } from '../../src/clients/git-auth'
import { JobType, STATUS_ESCALATED } from '@coro-ai/cloud-protocol'
import type { ToolContext } from '../../src/tools/types'
import {
  makeMockToolContext,
  makeMockToolContextWithSpies,
  makeMockJob,
} from './fixtures'

vi.mock('fs/promises')

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(),
}))

vi.mock('../../src/clients/git-auth', async () => {
  const actual = await vi.importActual<typeof import('../../src/clients/git-auth')>(
    '../../src/clients/git-auth',
  )
  return {
    ...actual,
    installRepoGitAuth: vi.fn().mockResolvedValue(undefined),
  }
})

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

  it('await_event sets awaitingEvent and optional awaitingPrId', async () => {
    const h = createMcpToolHandlers(ctx, signals)
    await h.await_event({ eventName: 'pr:merged', prId: 7 })
    expect(signals.awaitingEvent).toBe('pr:merged')
    expect(signals.awaitingPrId).toBe(7)

    await h.await_event({ eventName: 'comment' })
    expect(signals.awaitingEvent).toBe('comment')
    expect(signals.awaitingPrId).toBeUndefined()
  })

  // Every `scm_*` tool declares `prId` as number-or-string, so a model that
  // has been passing `"5"` all phase long will pass it here too. Rejecting
  // that read to the agent as the park being unavailable.
  it('await_event accepts a string prId and stores it as a number', async () => {
    const h = createMcpToolHandlers(ctx, signals)
    await h.await_event({ eventName: 'pr:approved', prId: '5' })
    expect(signals.awaitingPrId).toBe(5)
  })

  it('await_event rejects a prId that is not a number at all', async () => {
    const h = createMcpToolHandlers(ctx, signals)
    const out = await h.await_event({ eventName: 'pr:approved', prId: 'not-a-pr' })
    expect(out.isError).toBe(true)
    expect(signals.awaitingPrId).toBeUndefined()
  })

  it('escalate updates job in registry and sets signals', async () => {
    const h = createMcpToolHandlers(ctx, signals)
    const out = parseJson(await h.escalate({ reason: 'Blocked on auth' })) as Record<string, unknown>

    expect(ctx.stateBackend.updateJob).toHaveBeenCalledWith('job-mcp-test', {
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
    expect(ctx.stateBackend.appendLog).toHaveBeenCalledWith('job-mcp-test', 'Step done')
  })

  it('goto_phase accepts a declared phase', async () => {
    ctx.declaredPhases = ['planning', 'coding', 'review-and-verify']
    const h = createMcpToolHandlers(ctx, signals)
    const out = parseJson(await h.goto_phase({ phase: 'review-and-verify' })) as Record<string, unknown>
    expect(signals.nextPhase).toBe('review-and-verify')
    expect(out['goingToPhase']).toBe('review-and-verify')
  })

  it('goto_phase rejects an undeclared phase without setting nextPhase', async () => {
    ctx.declaredPhases = ['planning', 'coding', 'review-and-verify']
    const h = createMcpToolHandlers(ctx, signals)
    const out = await h.goto_phase({ phase: 'review' })
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toContain('review')
    expect(out.content[0].text).toContain('review-and-verify')
    expect(signals.nextPhase).toBeUndefined()
  })

  it('goto_phase is permissive when declaredPhases is unset', async () => {
    const h = createMcpToolHandlers(ctx, signals)
    await h.goto_phase({ phase: 'custom-phase' })
    expect(signals.nextPhase).toBe('custom-phase')
  })
})

// ── Legacy bb_*/gh_*/jira_* shims removed in S6 ─────────────────────────────
//
// The MCP-first plugins pivot deleted every back-compat wrapper.
// What used to be a thick block of routing tests now collapses to a
// single check: the handler surface no longer exports these names.
// Workflow markdown that still references them hits the SDK's
// "tool not found" path, which surfaces a clean error to the agent.

describe('createMcpToolHandlers — cross-job history', () => {
  function historyCtx(jobOverrides: Record<string, unknown>): ToolContext {
    const ctx = makeMockToolContext({ job: makeMockJob(jobOverrides) as ToolContext['job'] })
    ctx.stateBackend.listJobs = vi.fn().mockResolvedValue([])
    ctx.stateBackend.getLog = vi.fn().mockResolvedValue([])
    return ctx
  }

  it('registers the history and evidence tools', () => {
    const h = createMcpToolHandlers(makeMockToolContext(), {}) as Record<string, unknown>
    for (const name of [
      'list_jobs',
      'get_job_report',
      'get_job_log_excerpts',
      'cluster_window',
      'get_job_trace_summary',
    ]) {
      expect(typeof h[name], `${name} should be registered`).toBe('function')
    }
  })

  it('surfaces the retrospective-only gate as a structured tool error, not a throw', async () => {
    const h = createMcpToolHandlers(historyCtx({ type: JobType.Job }), {})

    const out = await h.list_jobs({})
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/only available to retrospective jobs/)
  })

  it('serves the history to a retrospective job', async () => {
    const h = createMcpToolHandlers(historyCtx({ id: 'retro-1', type: JobType.Retrospective }), {})

    const out = await h.list_jobs({})
    expect(out.isError).toBeUndefined()
    expect(parseJson(out)).toMatchObject({ scope: 'job', jobs: [] })
  })
})

describe('createMcpToolHandlers — legacy shim removal', () => {
  it('bb_*/gh_*/jira_* handlers are not exported', () => {
    const built = makeMockToolContextWithSpies()
    const h = createMcpToolHandlers(built.ctx, {}) as Record<string, unknown>
    for (const name of [
      'bb_create_repo', 'bb_create_pr', 'bb_get_pr_status', 'bb_get_pr_comments',
      'bb_post_pr_comment', 'bb_reply_to_comment', 'bb_approve_pr', 'bb_merge_pr',
      'gh_create_repo', 'gh_create_pr', 'gh_get_pr_status', 'gh_get_pr_comments',
      'gh_post_pr_comment', 'gh_reply_to_comment', 'gh_approve_pr', 'gh_merge_pr',
      'jira_get_issue', 'jira_post_comment', 'jira_transition_issue',
    ]) {
      expect(h[name]).toBeUndefined()
    }
  })
})

describe('createMcpToolHandlers — observability', () => {
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
})

describe('createMcpToolHandlers — scm_clone_repo', () => {
  const simpleGitMock = vi.mocked(simpleGit)
  const mkdirMock = vi.mocked(fs.mkdir)
  const statMock = vi.mocked(fs.stat)
  const readdirMock = vi.mocked(fs.readdir)
  const rmMock = vi.mocked(fs.rm)

  beforeEach(() => {
    mkdirMock.mockResolvedValue(undefined)
    statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    readdirMock.mockResolvedValue([])
    rmMock.mockResolvedValue(undefined)
    simpleGitMock.mockReset()
    vi.mocked(installRepoGitAuth).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('clones via the resolved scm plugin into the job working directory', async () => {
    const built = makeMockToolContextWithSpies()
    built.scmSpies['bitbucket'].cloneInfo.mockReturnValue({
      url: 'https://example.test/svc.git',
      envForGit: { GIT_TERMINAL_PROMPT: '0' },
    })
    const clone = vi.fn().mockResolvedValue(undefined)
    const env = vi.fn().mockReturnValue({ clone })
    simpleGitMock.mockReturnValue({ env } as never)

    const h = createMcpToolHandlers(built.ctx, {})
    const data = parseJson(await h.scm_clone_repo({ repo: 'svc' })) as Record<string, unknown>

    expect(simpleGitMock).toHaveBeenCalledWith(expect.objectContaining({ baseDir: '/tmp/work-mcp/job-mcp-test' }))
    // Regression: simple-git ≥3.36 scans spawn env. isolatedGitEnv sets
    // GIT_CONFIG_GLOBAL=/dev/null (neutralise ~/.gitconfig) and
    // GIT_CONFIG_COUNT + credential.helper (live SCM helper, no token
    // in the URL). Each needs its own unsafe opt-in; dropping any one
    // makes scm_clone_repo fail before git is spawned:
    //   GIT_CONFIG_GLOBAL  → allowUnsafeConfigPaths
    //   GIT_CONFIG_COUNT   → allowUnsafeConfigEnvCount
    //   credential.helper  → allowUnsafeCredentialHelper
    //   GIT_ASKPASS=''     → allowUnsafeAskPass
    expect(simpleGitMock).toHaveBeenCalledWith(expect.objectContaining({
      unsafe: expect.objectContaining({
        allowUnsafeAskPass: true,
        allowUnsafeConfigPaths: true,
        allowUnsafeConfigEnvCount: true,
        allowUnsafeCredentialHelper: true,
        allowUnsafeProtocolOverride: false,
      }),
    }))
    expect(env).toHaveBeenCalledWith(expect.objectContaining({
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_KEY_2: 'http.lowSpeedLimit',
      GIT_CONFIG_VALUE_2: '1000',
      GIT_CONFIG_KEY_3: 'http.lowSpeedTime',
      GIT_CONFIG_VALUE_3: '60',
    }))
    // Inner blob-fetch after a partial clone emits no stdio; a block
    // timeout would kill a healthy clone. Network stalls use http.lowSpeed*.
    expect(simpleGitMock.mock.calls[0]?.[0]).not.toHaveProperty('timeout')
    expect(clone).toHaveBeenCalledWith(
      'https://example.test/svc.git',
      '/tmp/work-mcp/job-mcp-test/svc',
      expect.arrayContaining([
        '--filter=blob:none',
        '--progress',
        '--config', 'url.https://bitbucket.org/.insteadOf=ssh://git@bitbucket.org/',
        '--config', 'url.https://github.com/.insteadOf=ssh://git@github.com/',
      ]),
    )
    expect(clone.mock.calls[0]?.[2]).not.toContain('--depth')
    expect(built.ctx.stateBackend.appendLog).toHaveBeenCalledWith(
      'job-mcp-test',
      '[repo-clone] starting svc',
    )
    expect(built.ctx.stateBackend.mapRepoToJob).toHaveBeenCalledWith('svc', 'job-mcp-test')
    expect(built.ctx.stateBackend.updateJob).toHaveBeenCalledWith(
      'job-mcp-test',
      expect.objectContaining({
        params: expect.objectContaining({
          repoCheckoutDir: 'svc',
          repoCheckoutAbsDir: '/tmp/work-mcp/job-mcp-test/svc',
        }),
      }),
    )
    expect(data['repoDir']).toBe('/tmp/work-mcp/job-mcp-test/svc')
    expect(data['reused']).toBe(false)
    expect(vi.mocked(installRepoGitAuth)).toHaveBeenCalledWith(
      '/tmp/work-mcp/job-mcp-test/svc',
      expect.objectContaining({ matchesRemote: expect.any(Function) }),
    )
  })

  it('logs pack growth while a silent blob-fetch is in flight', async () => {
    vi.useFakeTimers()
    const built = makeMockToolContextWithSpies()
    built.scmSpies['bitbucket'].cloneInfo.mockReturnValue({
      url: 'https://example.test/svc.git',
      envForGit: { GIT_TERMINAL_PROMPT: '0' },
    })
    let finish!: () => void
    const clone = vi.fn().mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    const env = vi.fn().mockReturnValue({ clone })
    simpleGitMock.mockReturnValue({ env } as never)
    readdirMock.mockImplementation(async (dir: unknown) => {
      if (String(dir).includes('pack')) return ['tmp_pack_x'] as never
      return [] as never
    })
    statMock.mockImplementation(async (filePath: unknown) => {
      if (String(filePath).includes('tmp_pack_x')) {
        return { isFile: () => true, size: 50 * 1024 * 1024 } as never
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const h = createMcpToolHandlers(built.ctx, {})
    const pending = h.scm_clone_repo({ repo: 'svc' })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(built.ctx.stateBackend.appendLog).toHaveBeenCalledWith(
      'job-mcp-test',
      '[repo-clone] svc still running (50MB on disk)',
    )
    finish()
    await pending
  })

  it('reuses an existing checkout when .git already exists', async () => {
    const built = makeMockToolContextWithSpies()
    statMock.mockImplementation(async (filePath: any) => {
      if (String(filePath).endsWith('/svc/.git')) return { isDirectory: () => true } as never
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const h = createMcpToolHandlers(built.ctx, {})
    const data = parseJson(await h.scm_clone_repo({ repo: 'svc' })) as Record<string, unknown>

    expect(simpleGitMock).not.toHaveBeenCalled()
    expect(built.ctx.stateBackend.updateJob).toHaveBeenCalledWith(
      'job-mcp-test',
      expect.objectContaining({
        params: expect.objectContaining({
          repoCheckoutDir: 'svc',
          repoCheckoutAbsDir: '/tmp/work-mcp/job-mcp-test/svc',
        }),
      }),
    )
    expect(data['reused']).toBe(true)
    expect(data['relativeDir']).toBe('svc')
    expect(vi.mocked(installRepoGitAuth)).toHaveBeenCalled()
  })

  it('does not reuse a checkout that still has an in-flight tmp_pack', async () => {
    const built = makeMockToolContextWithSpies()
    built.scmSpies['bitbucket'].cloneInfo.mockReturnValue({
      url: 'https://example.test/svc.git',
      envForGit: { GIT_TERMINAL_PROMPT: '0' },
    })
    const clone = vi.fn().mockResolvedValue(undefined)
    const env = vi.fn().mockReturnValue({ clone })
    simpleGitMock.mockReturnValue({ env } as never)
    statMock.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath)
      if (p.endsWith('/svc/.git') || p.endsWith('/svc')) {
        return { isDirectory: () => true } as never
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    readdirMock.mockImplementation(async (dir: unknown) => {
      if (String(dir).includes(`${'pack'}`)) return ['tmp_pack_eEXq0k'] as never
      return [] as never
    })

    const h = createMcpToolHandlers(built.ctx, {})
    await h.scm_clone_repo({ repo: 'svc' })

    expect(rmMock).toHaveBeenCalledWith(
      '/tmp/work-mcp/job-mcp-test/svc',
      expect.objectContaining({ recursive: true, force: true }),
    )
    expect(built.ctx.stateBackend.appendLog).toHaveBeenCalledWith(
      'job-mcp-test',
      '[repo-clone] removing incomplete checkout of svc',
    )
    expect(clone).toHaveBeenCalled()
  })

  it('removes a partial checkout and returns an error when clone stalls or fails', async () => {
    const built = makeMockToolContextWithSpies()
    built.scmSpies['bitbucket'].cloneInfo.mockReturnValue({
      url: 'https://example.test/svc.git',
      envForGit: { GIT_TERMINAL_PROMPT: '0' },
    })
    const clone = vi.fn().mockRejectedValue(new Error('killed'))
    const env = vi.fn().mockReturnValue({ clone })
    simpleGitMock.mockReturnValue({ env } as never)

    const h = createMcpToolHandlers(built.ctx, {})
    const result = await h.scm_clone_repo({ repo: 'svc' })

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Clone of "svc" failed')
    expect(result.content[0]?.text).toContain('killed')
    expect(rmMock).toHaveBeenCalledWith(
      '/tmp/work-mcp/job-mcp-test/svc',
      expect.objectContaining({ recursive: true, force: true }),
    )
    expect(built.ctx.stateBackend.appendLog).toHaveBeenCalledWith(
      'job-mcp-test',
      '[repo-clone] failed svc: killed',
    )
    expect(built.ctx.stateBackend.mapRepoToJob).not.toHaveBeenCalled()
  })

  it('retries without blob filter when the remote does not support partial clone', async () => {
    const built = makeMockToolContextWithSpies()
    built.scmSpies['bitbucket'].cloneInfo.mockReturnValue({
      url: 'https://example.test/svc.git',
      envForGit: { GIT_TERMINAL_PROMPT: '0' },
    })
    const clone = vi.fn()
      .mockRejectedValueOnce(new Error('fatal: the remote does not support the filter capability'))
      .mockResolvedValueOnce(undefined)
    const env = vi.fn().mockReturnValue({ clone })
    simpleGitMock.mockReturnValue({ env } as never)

    const h = createMcpToolHandlers(built.ctx, {})
    const data = parseJson(await h.scm_clone_repo({ repo: 'svc' })) as Record<string, unknown>

    expect(clone).toHaveBeenCalledTimes(2)
    expect(clone.mock.calls[0]?.[2]).toContain('--filter=blob:none')
    expect(clone.mock.calls[1]?.[2]).not.toContain('--filter=blob:none')
    expect(built.ctx.stateBackend.appendLog).toHaveBeenCalledWith(
      'job-mcp-test',
      '[repo-clone] partial clone unsupported, retrying full clone of svc',
    )
    expect(data['reused']).toBe(false)
    expect(vi.mocked(installRepoGitAuth)).toHaveBeenCalled()
  })
})

describe('createMcpToolHandlers — scm_get_clone_info', () => {
  it('returns a clean URL and never the plugin password', async () => {
    const built = makeMockToolContextWithSpies()
    built.scmSpies['bitbucket'].cloneInfo.mockReturnValue({
      url: 'https://bitbucket.org/acme/svc.git',
      username: 'x-bitbucket-api-token-auth',
      password: 'super-secret-token',
      envForGit: { GIT_TERMINAL_PROMPT: '0' },
    })
    const h = createMcpToolHandlers(built.ctx, {})
    const data = parseJson(await h.scm_get_clone_info({ repo: 'svc' })) as Record<string, unknown>
    const raw = JSON.stringify(data)
    expect(data['url']).toBe('https://bitbucket.org/acme/svc.git')
    expect(raw).not.toContain('super-secret-token')
    expect(data['password']).toBeUndefined()
    expect(data['auth']).toMatch(/credential helper/)
  })
})

describe('createMcpToolHandlers — scm_merge_pr', () => {
  it('marks the PR merged in state after a successful merge so local-mode jobs stay in sync', async () => {
    const built = makeMockToolContextWithSpies()

    const h = createMcpToolHandlers(built.ctx, {})
    const data = parseJson(await h.scm_merge_pr({ repo: 'svc', prId: 99 })) as Record<string, unknown>

    expect(data['merged']).toBe(true)
    // The plugin actually merged.
    expect(built.scmSpies['bitbucket'].mergePr).toHaveBeenCalledTimes(1)
    // The runner stamped mergedAt on the matching prMappings entry.
    expect(built.ctx.stateBackend.markPrMerged).toHaveBeenCalledWith(
      'job-mcp-test',
      99,
      expect.any(String),
    )
  })

  it('soft-fails when markPrMerged throws — the merge itself already succeeded', async () => {
    const built = makeMockToolContextWithSpies()
    ;(built.ctx.stateBackend.markPrMerged as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('no mapping for this PR'),
    )

    const h = createMcpToolHandlers(built.ctx, {})
    const data = parseJson(await h.scm_merge_pr({ repo: 'svc', prId: 42 })) as Record<string, unknown>

    expect(data['merged']).toBe(true)
    expect(built.ctx.logger.warn).toHaveBeenCalled()
  })

  it('skips markPrMerged when prId is non-numeric (defensive)', async () => {
    const built = makeMockToolContextWithSpies()

    const h = createMcpToolHandlers(built.ctx, {})
    const data = parseJson(
      await h.scm_merge_pr({ repo: 'svc', prId: 'not-a-number' as unknown as number }),
    ) as Record<string, unknown>

    expect(data['merged']).toBe(true)
    expect(built.ctx.stateBackend.markPrMerged).not.toHaveBeenCalled()
  })
})

describe('createMcpToolHandlers — work-item tracking', () => {
  let ctx: ReturnType<typeof makeMockToolContext>

  beforeEach(() => {
    ctx = makeMockToolContext()
  })

  it('set_work_items registers work items with pending status and loopCount 0', async () => {
    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.set_work_items({ workItems: ['scaffold', 'users-api'] })) as Record<string, unknown>

    expect(data['registered']).toBe(2)
    expect(ctx.stateBackend.updateJob).toHaveBeenCalledWith('job-mcp-test', {
      workItems: [
        { name: 'scaffold', status: 'pending', loopCount: 0 },
        { name: 'users-api', status: 'pending', loopCount: 0 },
      ],
    })
  })

  it('get_work_items returns work items and currentWorkItem from job', async () => {
    const jobWithWorkItems = makeMockJob({
      workItems: [{ name: 'f1', status: 'complete', loopCount: 1 }],
      currentWorkItem: 'f1',
    })
    ;(ctx.stateBackend.getJob as ReturnType<typeof vi.fn>).mockResolvedValue(jobWithWorkItems)

    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.get_work_items()) as Record<string, unknown>
    expect(data['currentWorkItem']).toBe('f1')
    expect((data['workItems'] as unknown[]).length).toBe(1)
  })

  it('update_work_item updates status and sets currentWorkItem when in-progress', async () => {
    const jobWithWorkItems = makeMockJob({
      workItems: [
        { name: 'f1', status: 'pending', loopCount: 0 },
        { name: 'f2', status: 'pending', loopCount: 0 },
      ],
    })
    ;(ctx.stateBackend.getJob as ReturnType<typeof vi.fn>).mockResolvedValue(jobWithWorkItems)

    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.update_work_item({ name: 'f1', status: 'in-progress' })) as Record<string, unknown>

    expect(data['updated']).toBe('f1')
    expect(data['status']).toBe('in-progress')
    expect(ctx.stateBackend.updateJob).toHaveBeenCalledWith(
      'job-mcp-test',
      expect.objectContaining({ currentWorkItem: 'f1' }),
    )
  })

  it('update_work_item increments loop count', async () => {
    const jobWithWorkItems = makeMockJob({
      workItems: [{ name: 'f1', status: 'in-progress', loopCount: 2 }],
    })
    ;(ctx.stateBackend.getJob as ReturnType<typeof vi.fn>).mockResolvedValue(jobWithWorkItems)

    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.update_work_item({ name: 'f1', incrementLoop: true })) as Record<string, unknown>

    expect(data['loopCount']).toBe(3)
  })

  it('request_new_session clears sessionId and logs reason', async () => {
    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.request_new_session({ reason: 'Starting next work item' })) as Record<string, unknown>

    expect(data['newSession']).toBe(true)
    expect(ctx.stateBackend.updateJob).toHaveBeenCalledWith('job-mcp-test', { sessionId: undefined })
    expect(ctx.stateBackend.appendLog).toHaveBeenCalledWith('job-mcp-test', '[session-reset] Starting next work item')
  })

  it('set_job_params merges params into job', async () => {
    const jobWithParams = makeMockJob({ params: { repoSlug: 'svc', reviewers: ['r'] } })
    ;(ctx.stateBackend.getJob as ReturnType<typeof vi.fn>).mockResolvedValue(jobWithParams)

    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.set_job_params({ params: { language: 'golang' } })) as Record<string, unknown>

    expect(data['updated']).toEqual(['language'])
    expect(ctx.stateBackend.updateJob).toHaveBeenCalledWith(
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
    ;(ctx.stateBackend.getJob as ReturnType<typeof vi.fn>).mockResolvedValue(jobWithInsights)

    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.add_insight({
      category: 'auth',
      summary: 'x-token-auth returns 401',
      detail: 'Used Basic auth with encoded username instead',
      suggestion: 'Update memory with working auth pattern',
    })) as Record<string, unknown>

    expect(data['recorded']).toBe(true)
    expect(data['totalInsights']).toBe(2)

    expect(ctx.stateBackend.updateJob).toHaveBeenCalledWith(
      'job-mcp-test',
      expect.objectContaining({
        insights: expect.arrayContaining([
          expect.objectContaining({ category: 'auth', summary: 'x-token-auth returns 401', phase: 'coding' }),
        ]),
      }),
    )

    expect(ctx.stateBackend.appendLog).toHaveBeenCalledWith(
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

describe('createMcpToolHandlers — artifacts', () => {
  let ctx: ReturnType<typeof makeMockToolContext>

  beforeEach(() => {
    ctx = makeMockToolContext()
  })

  it('post_artifact appends an artifact with defaults and logs it', async () => {
    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.post_artifact({
      kind: 'plan-md',
      title: 'Migration plan',
      data: { path: 'svc/migration-plan.md' },
    })) as Record<string, unknown>

    expect(data['kind']).toBe('plan-md')
    expect(data['title']).toBe('Migration plan')
    expect(data['phase']).toBe('coding') // defaulted from ctx.job.phase
    expect(typeof data['id']).toBe('string')
    expect((data['id'] as string).startsWith('art-')).toBe(true)

    expect(ctx.stateBackend.updateJob).toHaveBeenCalledWith(
      'job-mcp-test',
      expect.objectContaining({
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            kind: 'plan-md',
            title: 'Migration plan',
            phase: 'coding',
            data: { path: 'svc/migration-plan.md' },
          }),
        ]),
      }),
    )

    expect(ctx.stateBackend.appendLog).toHaveBeenCalledWith(
      'job-mcp-test',
      '[artifact] coding/plan-md: Migration plan',
    )
  })

  it('post_artifact accepts an explicit phase override', async () => {
    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.post_artifact({
      phase: 'planning',
      kind: 'plan-md',
      title: 'Plan',
      data: {},
    })) as Record<string, unknown>

    expect(data['phase']).toBe('planning')
  })

  it('post_artifact preserves existing artifacts', async () => {
    const existing = {
      id: 'art-1',
      phase: 'planning',
      kind: 'plan-md',
      title: 'Earlier plan',
      data: {},
      createdBy: 'planning',
      createdAt: '2026-01-01T00:00:00Z',
    }
    ;(ctx.stateBackend.getJob as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockJob({ artifacts: [existing] }),
    )

    const h = createMcpToolHandlers(ctx, {})
    await h.post_artifact({ kind: 'pr-link', title: 'PR #1', data: {} })

    const patchArg = (ctx.stateBackend.updateJob as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(patchArg.artifacts).toHaveLength(2)
    expect(patchArg.artifacts[0]).toEqual(existing)
    expect(patchArg.artifacts[1].kind).toBe('pr-link')
  })

  it('get_artifacts returns all artifacts when no phase given', async () => {
    const artifacts = [
      { id: 'a1', phase: 'planning', kind: 'plan-md', title: 'p', data: {}, createdBy: 'planning', createdAt: 't' },
      { id: 'a2', phase: 'coding', kind: 'pr-link', title: 'pr', data: {}, createdBy: 'coding', createdAt: 't' },
    ]
    ;(ctx.stateBackend.getJob as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockJob({ artifacts }),
    )

    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.get_artifacts({})) as Record<string, unknown>
    expect(data['total']).toBe(2)
    expect((data['artifacts'] as unknown[]).length).toBe(2)
  })

  it('get_artifacts filters by phase', async () => {
    const artifacts = [
      { id: 'a1', phase: 'planning', kind: 'plan-md', title: 'p', data: {}, createdBy: 'planning', createdAt: 't' },
      { id: 'a2', phase: 'coding', kind: 'pr-link', title: 'pr', data: {}, createdBy: 'coding', createdAt: 't' },
    ]
    ;(ctx.stateBackend.getJob as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMockJob({ artifacts }),
    )

    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.get_artifacts({ phase: 'coding' })) as Record<string, unknown>
    expect(data['total']).toBe(1)
    expect((data['artifacts'] as unknown[])[0]).toMatchObject({ kind: 'pr-link' })
  })

  it('get_artifacts returns empty list when job has no artifacts field', async () => {
    const jobNoArtifacts = makeMockJob()
    delete (jobNoArtifacts as Record<string, unknown>)['artifacts']
    ;(ctx.stateBackend.getJob as ReturnType<typeof vi.fn>).mockResolvedValue(jobNoArtifacts)

    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.get_artifacts({})) as Record<string, unknown>
    expect(data['total']).toBe(0)
  })
})

// ── propose_change / list_proposals ──────────────────────────────────────────
//
// `propose_change` now opens a real PR via the writer module. We
// stub the writer at module level so these handler tests verify the
// MCP plumbing (input shape, error surfacing, state-backend wiring)
// without exercising git or HTTP.

vi.mock('../../src/intelligence/writer', () => ({
  prepareTenantWriter: vi.fn(async () => ({
    dir: '/tmp/writer/tenant',
    baseRef: 'main',
    remoteUrl: 'git@github.com:acme/intel.git',
  })),
  prepareRepoWriter: vi.fn(async () => ({
    dir: '/tmp/working/proposal-job/my-repo',
    baseRef: 'main',
    remoteUrl: 'git@github.com:acme/my-repo.git',
  })),
  commitAndPush: vi.fn(async () => undefined),
  openProposalPr: vi.fn(async () => ({
    id: 99,
    url: 'https://github.com/acme/intel/pull/99',
    provider: 'github' as const,
  })),
}))

describe('createMcpToolHandlers — propose_change / list_proposals', () => {
  let ctx: ReturnType<typeof makeMockToolContext>
  const proposalsStore = new Map<string, import('@coro-ai/cloud-protocol').Proposal>()

  beforeEach(() => {
    vi.clearAllMocks()
    proposalsStore.clear()

    ctx = makeMockToolContext({
      job: makeMockJob({ id: 'proposal-job', params: { repoSlug: 'my-repo' } }),
      settings: {
        paths: { coroIntelligenceDir: '/data/a5ai', workingDir: '/tmp/w' },
        proposals: { routing: { strategy: 'path' } },
      } as ToolContext['settings'],
      tenantContext: {
        tenantId: 'team-acme',
        mode: 'team' as const,
        displayName: 'Team ACME',
        overlay: { kind: 'gitRemote', url: 'git@github.com:acme/intel.git', ref: 'main' },
      },
    })
    // Override stateBackend.createProposal / listProposals to use a local store.
    ;(ctx.stateBackend.createProposal as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      async (p: Omit<import('@coro-ai/cloud-protocol').Proposal, 'id'>) => {
        const id = `proposal-${proposalsStore.size + 1}`
        const stored: import('@coro-ai/cloud-protocol').Proposal = { ...p, id }
        proposalsStore.set(id, stored)
        return stored
      },
    )
    ;(ctx.stateBackend.listProposals as unknown as ReturnType<typeof vi.fn>) = vi.fn(
      async (tenantId: string) =>
        Array.from(proposalsStore.values()).filter(p => p.tenantId === tenantId),
    )
  })

  it('propose_change ships the proposal and returns a PR URL', async () => {
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

    expect(data['targetLayer']).toBe('tenant')
    expect(data['prUrl']).toBe('https://github.com/acme/intel/pull/99')
    expect(data['filesShipped']).toEqual(['memory/x.md'])
    expect(ctx.stateBackend.createProposal).toHaveBeenCalled()
  })

  it('propose_change surfaces validation errors as a structured tool error', async () => {
    const h = createMcpToolHandlers(ctx, {})
    const result = await h.propose_change({
      type: 'skill-create',
      title: 'Bad skill',
      rationale: 'r',
      description: 'd',
      // Wrong path for a skill — should fail validation before any git happens
      files: [{ path: 'agents/not-a-skill.md', content: 'x' }],
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(result.content[0].text).toContain('Skill files must live under')
  })

  it('list_proposals returns an empty list for a fresh tenant', async () => {
    const h = createMcpToolHandlers(ctx, {})
    const data = parseJson(await h.list_proposals({})) as Record<string, unknown>
    expect(data['proposals']).toEqual([])
    expect(data['count']).toBe(0)
    expect(data['totalForTenant']).toBe(0)
  })

  it('list_proposals returns previously-recorded proposals for the tenant', async () => {
    const h = createMcpToolHandlers(ctx, {})
    await h.propose_change({
      type: 'memory-update',
      title: 'First',
      rationale: 'r',
      description: 'd',
      files: [{ path: 'memory/a.md', content: '# A' }],
    })
    const data = parseJson(await h.list_proposals({})) as Record<string, unknown>
    expect(data['count']).toBe(1)
    expect((data['proposals'] as Array<Record<string, unknown>>)[0]['title']).toBe('First')
  })
})
