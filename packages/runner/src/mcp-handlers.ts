import { ToolContext, PhaseSignals } from './tools/types'
import { Artifact, WorkItem, Insight, Job } from './jobs/types'
import type { ExternalRef } from './plugins/refs'
import type { ScmPluginRuntime, TrackerPluginRuntime } from './plugins/types'
import { PluginResolutionError } from './plugins/registry'
import {
  DeprecatedMcpToolError,
  legacyMcpWrapperBehaviour,
} from './plugins/deprecation'

// ── Response helpers (shared with MCP server wiring) ──────────────────────────

export function mcpText(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

export function mcpError(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], isError: true as const }
}

// ── Plugin resolution helpers ────────────────────────────────────────────────
//
// `scm_*` and `tracker_*` handlers all need the same boilerplate: pick
// the per-job-or-explicit plugin, surface a structured MCP error when
// resolution fails so the agent can re-call with a corrected
// `pluginId`. Centralised here so each tool stays a one-liner that
// just dispatches to the chosen plugin's method.

function resolveScm(
  ctx: ToolContext,
  pluginId?: string,
): { ok: true; scm: ScmPluginRuntime } | { ok: false; error: ReturnType<typeof mcpError> } {
  try {
    const requested = pluginId ?? (typeof ctx.job.params['scm'] === 'string' ? (ctx.job.params['scm'] as string) : undefined)
    const scm = ctx.plugins.resolveScm(requested ? { scm: requested } : {})
    return { ok: true, scm }
  } catch (err) {
    if (err instanceof PluginResolutionError) {
      return { ok: false, error: mcpError(`scm plugin resolution failed: ${err.message}`) }
    }
    return { ok: false, error: mcpError(`scm plugin resolution error: ${(err as Error).message}`) }
  }
}

function resolveTracker(
  ctx: ToolContext,
  pluginId?: string,
): { ok: true; tracker: TrackerPluginRuntime } | { ok: false; error: ReturnType<typeof mcpError> } {
  try {
    const requested = pluginId ?? (typeof ctx.job.params['tracker'] === 'string' ? (ctx.job.params['tracker'] as string) : undefined)
    const tracker = ctx.plugins.resolveTracker(requested ? { tracker: requested } : {})
    return { ok: true, tracker }
  } catch (err) {
    if (err instanceof PluginResolutionError) {
      return { ok: false, error: mcpError(`tracker plugin resolution failed: ${err.message}`) }
    }
    return { ok: false, error: mcpError(`tracker plugin resolution error: ${(err as Error).message}`) }
  }
}

/**
 * Build an `ExternalRef` for a PR from the args MCP tools accept.
 * Stringifies the PR id (PRs are numbers in most providers but the
 * ref is provider-neutral string).
 */
function prRef(scm: ScmPluginRuntime, repo: string, prId: number | string): ExternalRef {
  return {
    kind: 'pull_request',
    pluginId: scm.manifest.id,
    repoKey: repo,
    externalId: String(prId),
  }
}

/**
 * Stage-aware deprecation gate for `bb_*` / `gh_*` / `jira_*`
 * wrappers. The stage matrix lives in `plugins/deprecation.ts`:
 *
 *   N    → log a warning and let the wrapper proceed.
 *   N+1  → throw {@link DeprecatedMcpToolError}; the wrapper body
 *          never runs and the agent sees a structured MCP error
 *          pointing at the new tool.
 *   N+2  → wrapper not registered at all (mcp-server filters at
 *          registration time); kept here as a guard in case a
 *          stale code path still calls in.
 *
 * Every wrapper calls this as the first statement. If it returns,
 * the legacy code path proceeds; otherwise it throws and the SDK
 * surfaces the error to the model.
 */
function logDeprecation(ctx: ToolContext, oldName: string, newName: string, extra?: Record<string, unknown>): void {
  const stage = legacyMcpWrapperBehaviour()
  if (stage === 'warn') {
    ctx.logger.warn(
      { tool: oldName, replacement: newName, jobId: ctx.job.id, ...extra },
      `MCP tool ${oldName} is deprecated — agents should call ${newName}`,
    )
    return
  }
  // 'error' (N+1) and 'remove' (N+2 fallback) both surface the same
  // structured error to the agent.
  throw new DeprecatedMcpToolError(oldName, newName)
}

/**
 * All Coro MCP tool implementations. Used by `createCoroMcpServer` and by tests
 * that invoke handlers with a mock {@link ToolContext}.
 */
export function createMcpToolHandlers(ctx: ToolContext, signals: PhaseSignals) {
  const text = mcpText
  const error = mcpError

  const setWorkItems = async ({ workItems }: { workItems: string[] }) => {
    const items: WorkItem[] = workItems.map(name => ({
      name, status: 'pending', loopCount: 0,
    }))
    await ctx.stateBackend.updateJob(ctx.job.id, { workItems: items })
    ctx.job = await ctx.stateBackend.getJob(ctx.job.id) as Job
    return text({ registered: workItems.length })
  }

  const updateWorkItem = async ({ name, status, incrementLoop }: {
    name: string; status?: string; incrementLoop?: boolean
  }) => {
    const job = await ctx.stateBackend.getJob(ctx.job.id) as Job
    const workItems = job.workItems.map(item => {
      if (item.name !== name) return item
      return {
        ...item,
        ...(status ? { status: status as WorkItem['status'] } : {}),
        loopCount: incrementLoop ? item.loopCount + 1 : item.loopCount,
      }
    })
    const current = workItems.find(item => item.name === name)
    await ctx.stateBackend.updateJob(ctx.job.id, {
      workItems,
      currentWorkItem: status === 'in-progress' ? name : ctx.job.currentWorkItem,
      workItemLoopCount: current?.loopCount ?? ctx.job.workItemLoopCount,
    })
    ctx.job = await ctx.stateBackend.getJob(ctx.job.id) as Job
    return text({ updated: name, status: current?.status, loopCount: current?.loopCount })
  }

  const getWorkItems = async () => {
    const job = await ctx.stateBackend.getJob(ctx.job.id) as Job
    ctx.job = job
    return text({ workItems: job.workItems, currentWorkItem: job.currentWorkItem })
  }

  // ── Generic SCM tools ──────────────────────────────────────────────────
  //
  // These delegate to whichever SCM plugin the registry resolves for
  // the job. Every provider (BitBucket, GitHub, future Gitea/GitLab)
  // implements the same shape, so workflow markdown can stop hard-
  // coding `bb_*`/`gh_*`. The legacy wrappers below now forward to
  // these.

  const scm_create_repo = async (args: {
    pluginId?: string; repoSlug: string; description?: string; isPrivate?: boolean; defaultBranch?: string
  }) => {
    const r = resolveScm(ctx, args.pluginId)
    if (!r.ok) return r.error
    if (!r.scm.createRepo) return error(`scm plugin "${r.scm.manifest.id}" does not support createRepo`)
    const ref = await r.scm.createRepo({
      repoSlug: args.repoSlug,
      ...(args.description ? { description: args.description } : {}),
      ...(args.isPrivate !== undefined ? { isPrivate: args.isPrivate } : {}),
      ...(args.defaultBranch ? { defaultBranch: args.defaultBranch } : {}),
    })
    return text({ pluginId: ref.pluginId, fullName: ref.externalId, url: ref.url ?? null })
  }

  const scm_create_pr = async (args: {
    pluginId?: string
    repo: string
    title: string
    description?: string
    sourceBranch: string
    targetBranch?: string
    reviewers?: string[]
  }) => {
    const r = resolveScm(ctx, args.pluginId)
    if (!r.ok) return r.error
    const { jobReviewers } = await import('./jobs/types')
    const ref = await r.scm.createPr({
      repoSlug: args.repo,
      title: args.title,
      ...(args.description ? { description: args.description } : {}),
      sourceBranch: args.sourceBranch,
      targetBranch: args.targetBranch ?? 'main',
      reviewers: args.reviewers ?? jobReviewers(ctx.job),
    })

    const prIdNumber = Number(ref.externalId)
    if (Number.isFinite(prIdNumber)) {
      // Legacy `prMappings` table still records numeric PR ids per job
      // for back-compat with consumers that haven't moved off the old
      // shape (e.g. `markPrMerged` and the PR-merged work item watcher).
      await ctx.stateBackend.addPrMapping(ctx.job.id, {
        prId: prIdNumber,
        workItem: ctx.job.currentWorkItem ?? ctx.job.phase,
        repoSlug: args.repo,
        openedAt: new Date().toISOString(),
      })
    }
    // Plugin-aware mapping in `external_ref_mappings`: this is the
    // path resolveJobByExternalRef + the polling/webhook bridge use,
    // and it carries enough provenance to disambiguate PR id 42 across
    // repositories or providers.
    await ctx.stateBackend.mapExternalRef(ref, ctx.job.id)

    return text({
      pluginId: ref.pluginId,
      prId: prIdNumber,
      externalId: ref.externalId,
      url: ref.url ?? null,
    })
  }

  const scm_get_pr_status = async (args: { pluginId?: string; repo: string; prId: number | string }) => {
    const r = resolveScm(ctx, args.pluginId)
    if (!r.ok) return r.error
    const status = await r.scm.getPrStatus(prRef(r.scm, args.repo, args.prId))
    return text(status)
  }

  const scm_list_pr_comments = async (args: { pluginId?: string; repo: string; prId: number | string }) => {
    const r = resolveScm(ctx, args.pluginId)
    if (!r.ok) return r.error
    const comments = await r.scm.listPrComments(prRef(r.scm, args.repo, args.prId))
    return text(comments)
  }

  const scm_post_pr_comment = async (args: {
    pluginId?: string; repo: string; prId: number | string; body: string
  }) => {
    const r = resolveScm(ctx, args.pluginId)
    if (!r.ok) return r.error
    const comment = await r.scm.postPrComment(prRef(r.scm, args.repo, args.prId), args.body)
    return text(comment)
  }

  const scm_reply_to_comment = async (args: {
    pluginId?: string; repo: string; prId: number | string; parentId: string | number; body: string
  }) => {
    const r = resolveScm(ctx, args.pluginId)
    if (!r.ok) return r.error
    const comment = await r.scm.replyToComment(prRef(r.scm, args.repo, args.prId), String(args.parentId), args.body)
    return text(comment)
  }

  const scm_approve_pr = async (args: { pluginId?: string; repo: string; prId: number | string }) => {
    const r = resolveScm(ctx, args.pluginId)
    if (!r.ok) return r.error
    if (!r.scm.approvePr) return error(`scm plugin "${r.scm.manifest.id}" does not support approvePr`)
    await r.scm.approvePr(prRef(r.scm, args.repo, args.prId))
    return text({ approved: true })
  }

  const scm_merge_pr = async (args: {
    pluginId?: string; repo: string; prId: number | string; message?: string; strategy?: 'merge' | 'squash' | 'rebase'
  }) => {
    const r = resolveScm(ctx, args.pluginId)
    if (!r.ok) return r.error
    if (!r.scm.mergePr) return error(`scm plugin "${r.scm.manifest.id}" does not support mergePr`)
    await r.scm.mergePr(
      prRef(r.scm, args.repo, args.prId),
      {
        ...(args.message ? { message: args.message } : {}),
        ...(args.strategy ? { strategy: args.strategy } : {}),
      },
    )
    return text({ merged: true })
  }

  const scm_get_clone_info = async (args: { pluginId?: string; repo: string }) => {
    const r = resolveScm(ctx, args.pluginId)
    if (!r.ok) return r.error
    const info = r.scm.cloneInfo({ repo: args.repo })
    return text({ pluginId: r.scm.manifest.id, ...info })
  }

  const scm_poll_pr = async (args: { pluginId?: string; repo: string; prId: number | string }) => {
    const r = resolveScm(ctx, args.pluginId)
    if (!r.ok) return r.error
    const snap = await r.scm.pollPr(prRef(r.scm, args.repo, args.prId))
    return text(snap)
  }

  // ── Generic Tracker tools ──────────────────────────────────────────────
  //
  // Same idea as scm_*: every tracker plugin implements the same
  // surface; the registry picks one. The legacy `tracker_*` handlers
  // (which went through `ctx.trackerClient`) are replaced by these.

  const tracker_get_issue = async (args: { pluginId?: string; key: string }) => {
    const r = resolveTracker(ctx, args.pluginId)
    if (!r.ok) return r.error
    try {
      const issue = await r.tracker.getIssue(args.key)
      return text(issue)
    } catch (err) {
      return error((err as Error).message)
    }
  }

  const tracker_list_children = async (args: { pluginId?: string; parentKey: string }) => {
    const r = resolveTracker(ctx, args.pluginId)
    if (!r.ok) return r.error
    if (!r.tracker.listChildren) return error(`tracker plugin "${r.tracker.manifest.id}" does not support listChildren`)
    try {
      const issues = await r.tracker.listChildren(args.parentKey)
      return text(issues)
    } catch (err) {
      return error((err as Error).message)
    }
  }

  const tracker_comment_issue = async (args: { pluginId?: string; key: string; body: string }) => {
    const r = resolveTracker(ctx, args.pluginId)
    if (!r.ok) return r.error
    try {
      await r.tracker.commentIssue({ key: args.key, body: args.body })
      return text({ commented: true, key: args.key })
    } catch (err) {
      return error((err as Error).message)
    }
  }

  const tracker_transition_issue = async (args: { pluginId?: string; key: string; status: string }) => {
    const r = resolveTracker(ctx, args.pluginId)
    if (!r.ok) return r.error
    try {
      await r.tracker.transitionIssue({ key: args.key, status: args.status })
      return text({ transitioned: true, key: args.key, status: args.status })
    } catch (err) {
      return error((err as Error).message)
    }
  }

  const tracker_create_issue = async (args: {
    pluginId?: string
    projectKey: string
    summary: string
    description: string
    issueType?: string
    parentKey?: string
    labels?: string[]
  }) => {
    const r = resolveTracker(ctx, args.pluginId)
    if (!r.ok) return r.error
    if (!r.tracker.createIssue) return error(`tracker plugin "${r.tracker.manifest.id}" does not support createIssue`)
    try {
      const issue = await r.tracker.createIssue({
        projectKey: args.projectKey,
        summary: args.summary,
        description: args.description,
        ...(args.issueType ? { issueType: args.issueType } : {}),
        ...(args.parentKey ? { parentKey: args.parentKey } : {}),
        ...(args.labels ? { labels: args.labels } : {}),
      })
      return text(issue)
    } catch (err) {
      return error((err as Error).message)
    }
  }

  const tracker_create_epic = async (args: {
    pluginId?: string
    projectKey: string
    summary: string
    description: string
    labels?: string[]
  }) => {
    const r = resolveTracker(ctx, args.pluginId)
    if (!r.ok) return r.error
    if (!r.tracker.createEpic) return error(`tracker plugin "${r.tracker.manifest.id}" does not support createEpic`)
    try {
      const epic = await r.tracker.createEpic({
        projectKey: args.projectKey,
        summary: args.summary,
        description: args.description,
        ...(args.labels ? { labels: args.labels } : {}),
      })
      return text(epic)
    } catch (err) {
      return error((err as Error).message)
    }
  }

  const tracker_link_issues = async (args: {
    pluginId?: string; fromKey: string; toKey: string; relation?: string
  }) => {
    const r = resolveTracker(ctx, args.pluginId)
    if (!r.ok) return r.error
    if (!r.tracker.linkIssues) return error(`tracker plugin "${r.tracker.manifest.id}" does not support linkIssues`)
    try {
      await r.tracker.linkIssues({
        fromKey: args.fromKey,
        toKey: args.toKey,
        relation: args.relation ?? 'Blocks',
      })
      return text({ linked: true, fromKey: args.fromKey, toKey: args.toKey })
    } catch (err) {
      return error((err as Error).message)
    }
  }

  return {
    // ── Generic surface (preferred) ────────────────────────────────────
    scm_create_repo,
    scm_create_pr,
    scm_get_pr_status,
    scm_list_pr_comments,
    scm_post_pr_comment,
    scm_reply_to_comment,
    scm_approve_pr,
    scm_merge_pr,
    scm_get_clone_info,
    scm_poll_pr,

    tracker_get_issue,
    tracker_list_children,
    tracker_comment_issue,
    tracker_transition_issue,
    tracker_create_issue,
    tracker_create_epic,
    tracker_link_issues,

    // ── BitBucket back-compat shims (DEPRECATED) ─────────────────────
    //
    // These delegate straight through to the generic handlers above
    // with `pluginId: 'bitbucket'`. Each call emits a single
    // deprecation log line so operators can see how often legacy
    // markdown still gets used. P9 turns these into MCP errors at
    // N+1 and removes them at N+2.
    bb_create_repo: async ({ repoSlug, description }: { repoSlug: string; description?: string }) => {
      logDeprecation(ctx, 'bb_create_repo', 'scm_create_repo')
      return scm_create_repo({ pluginId: 'bitbucket', repoSlug, ...(description ? { description } : {}), isPrivate: true })
    },

    bb_create_pr: async ({
      repoSlug, title, description, sourceBranch, targetBranch, reviewerUsernames,
    }: {
      repoSlug: string
      title: string
      description?: string
      sourceBranch: string
      targetBranch?: string
      reviewerUsernames?: string[]
    }) => {
      logDeprecation(ctx, 'bb_create_pr', 'scm_create_pr')
      return scm_create_pr({
        pluginId: 'bitbucket',
        repo: repoSlug,
        title,
        ...(description ? { description } : {}),
        sourceBranch,
        ...(targetBranch ? { targetBranch } : {}),
        ...(reviewerUsernames ? { reviewers: reviewerUsernames } : {}),
      })
    },

    bb_get_pr_status: async ({ repoSlug, prId }: { repoSlug: string; prId: number }) => {
      logDeprecation(ctx, 'bb_get_pr_status', 'scm_get_pr_status')
      return scm_get_pr_status({ pluginId: 'bitbucket', repo: repoSlug, prId })
    },

    // BitBucket — reviewer
    bb_get_pr_comments: async ({ repoSlug, prId }: { repoSlug: string; prId: number }) => {
      logDeprecation(ctx, 'bb_get_pr_comments', 'scm_list_pr_comments')
      return scm_list_pr_comments({ pluginId: 'bitbucket', repo: repoSlug, prId })
    },

    bb_post_pr_comment: async ({ repoSlug, prId, content }: { repoSlug: string; prId: number; content: string }) => {
      logDeprecation(ctx, 'bb_post_pr_comment', 'scm_post_pr_comment')
      return scm_post_pr_comment({ pluginId: 'bitbucket', repo: repoSlug, prId, body: content })
    },

    bb_reply_to_comment: async ({
      repoSlug, prId, parentId, content,
    }: { repoSlug: string; prId: number; parentId: number; content: string }) => {
      logDeprecation(ctx, 'bb_reply_to_comment', 'scm_reply_to_comment')
      return scm_reply_to_comment({ pluginId: 'bitbucket', repo: repoSlug, prId, parentId, body: content })
    },

    bb_approve_pr: async ({ repoSlug, prId }: { repoSlug: string; prId: number }) => {
      logDeprecation(ctx, 'bb_approve_pr', 'scm_approve_pr')
      return scm_approve_pr({ pluginId: 'bitbucket', repo: repoSlug, prId })
    },

    bb_merge_pr: async ({ repoSlug, prId, message }: { repoSlug: string; prId: number; message?: string }) => {
      logDeprecation(ctx, 'bb_merge_pr', 'scm_merge_pr')
      return scm_merge_pr({ pluginId: 'bitbucket', repo: repoSlug, prId, ...(message ? { message } : {}) })
    },

    // GitHub back-compat shims (DEPRECATED — see bb_* note above).
    gh_create_repo: async ({ repoSlug, description }: { repoSlug: string; description?: string }) => {
      logDeprecation(ctx, 'gh_create_repo', 'scm_create_repo')
      return scm_create_repo({ pluginId: 'github', repoSlug, ...(description ? { description } : {}), isPrivate: true })
    },

    gh_create_pr: async ({
      repoSlug, title, description, sourceBranch, targetBranch, reviewerUsernames,
    }: {
      repoSlug: string
      title: string
      description?: string
      sourceBranch: string
      targetBranch?: string
      reviewerUsernames?: string[]
    }) => {
      logDeprecation(ctx, 'gh_create_pr', 'scm_create_pr')
      return scm_create_pr({
        pluginId: 'github',
        repo: repoSlug,
        title,
        ...(description ? { description } : {}),
        sourceBranch,
        ...(targetBranch ? { targetBranch } : {}),
        ...(reviewerUsernames ? { reviewers: reviewerUsernames } : {}),
      })
    },

    gh_get_pr_status: async ({ repoSlug, prId }: { repoSlug: string; prId: number }) => {
      logDeprecation(ctx, 'gh_get_pr_status', 'scm_get_pr_status')
      return scm_get_pr_status({ pluginId: 'github', repo: repoSlug, prId })
    },

    gh_get_pr_comments: async ({ repoSlug, prId }: { repoSlug: string; prId: number }) => {
      logDeprecation(ctx, 'gh_get_pr_comments', 'scm_list_pr_comments')
      return scm_list_pr_comments({ pluginId: 'github', repo: repoSlug, prId })
    },

    gh_post_pr_comment: async ({ repoSlug, prId, content }: { repoSlug: string; prId: number; content: string }) => {
      logDeprecation(ctx, 'gh_post_pr_comment', 'scm_post_pr_comment')
      return scm_post_pr_comment({ pluginId: 'github', repo: repoSlug, prId, body: content })
    },

    gh_reply_to_comment: async ({
      repoSlug, prId, parentId, content,
    }: { repoSlug: string; prId: number; parentId: number; content: string }) => {
      logDeprecation(ctx, 'gh_reply_to_comment', 'scm_reply_to_comment')
      return scm_reply_to_comment({ pluginId: 'github', repo: repoSlug, prId, parentId, body: content })
    },

    gh_approve_pr: async ({ repoSlug, prId }: { repoSlug: string; prId: number }) => {
      logDeprecation(ctx, 'gh_approve_pr', 'scm_approve_pr')
      return scm_approve_pr({ pluginId: 'github', repo: repoSlug, prId })
    },

    gh_merge_pr: async ({ repoSlug, prId, message }: { repoSlug: string; prId: number; message?: string }) => {
      logDeprecation(ctx, 'gh_merge_pr', 'scm_merge_pr')
      return scm_merge_pr({ pluginId: 'github', repo: repoSlug, prId, ...(message ? { message } : {}) })
    },

    // Test harness
    run_go_build: async ({ repoDir }: { repoDir: string }) => {
      const { exec: execCb } = await import('child_process')
      const { promisify } = await import('util')
      const execAsync = promisify(execCb)
      try {
        const { stdout, stderr } = await execAsync('go build ./...', {
          cwd: repoDir, timeout: 120_000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        })
        return text({ stdout: stdout.trim(), stderr: stderr.trim() })
      } catch (err: unknown) {
        const e = err as { stderr?: string; message?: string }
        return error(e.stderr ?? e.message ?? String(err))
      }
    },

    start_go_service: async ({
      label, repoDir, binaryName, port, env: extraEnv,
    }: {
      label: string
      repoDir: string
      binaryName: string
      port: number
      env?: Record<string, string>
    }) => {
      if (ctx.runningServices.has(label)) return error(`Service "${label}" is already running`)
      const { spawn } = await import('child_process')
      const child = spawn(`./${binaryName}`, [], {
        cwd: repoDir,
        env: { ...process.env, PORT: String(port), ...extraEnv },
        stdio: 'ignore', detached: false,
      })
      ctx.runningServices.set(label, child)
      child.on('exit', () => { ctx.runningServices.delete(label) })
      await new Promise(r => setTimeout(r, 1500))
      return text({ label, port, pid: child.pid })
    },

    stop_go_service: async ({ label }: { label: string }) => {
      const child = ctx.runningServices.get(label)
      if (!child) return error(`No running service with label "${label}"`)
      child.kill('SIGTERM')
      ctx.runningServices.delete(label)
      return text({ stopped: label })
    },

    compare_request: async ({
      goBaseUrl, dotnetBaseUrl, method, path: reqPath, headers, body,
    }: {
      goBaseUrl: string
      dotnetBaseUrl: string
      method: string
      path: string
      headers?: Record<string, string>
      body?: string
    }) => {
      const doReq = async (base: string) => {
        const res = await fetch(`${base}${reqPath}`, {
          method, body: body ?? undefined,
          headers: { 'Content-Type': 'application/json', ...headers },
          signal: AbortSignal.timeout(15_000),
        })
        return { status: res.status, body: await res.text() }
      }
      const [goRes, dotnetRes] = await Promise.all([doReq(goBaseUrl), doReq(dotnetBaseUrl)])
      const norm = (s: string) => { try { return JSON.stringify(JSON.parse(s)) } catch { return s.trim() } }
      return text({
        match: goRes.status === dotnetRes.status && norm(goRes.body) === norm(dotnetRes.body),
        go: goRes, dotnet: dotnetRes,
      })
    },

    // Observability
    loki_query: async ({
      logQL, start, end, limit,
    }: { logQL: string; start: string; end?: string; limit?: number }) => {
      const result = await ctx.lokiClient.query(logQL, start, end ?? 'now', limit ?? 500)
      return text(result)
    },

    tempo_get_trace: async ({ traceId }: { traceId: string }) => {
      const result = await ctx.tempoClient.getTrace(traceId)
      return text(result)
    },

    tempo_search: async ({
      query: q, start, end, limit,
    }: { query: string; start: string; end?: string; limit?: number }) => {
      const result = await ctx.tempoClient.search(q, start, end, limit ?? 20)
      return text(result)
    },

    // Jira back-compat shims (DEPRECATED).
    //
    // The tracker plugin's `transitionIssue` takes a *status name*
    // (e.g. `"Done"`); the legacy Jira tool took a numeric Jira
    // transition id (e.g. `"11"`). The plugin handles the lookup
    // internally so the wrapper just renames the field — the semantic
    // is identical for any modern Jira project (transition names map
    // 1:1 to ids inside the plugin).
    jira_get_issue: async ({ ticketId }: { ticketId: string }) => {
      logDeprecation(ctx, 'jira_get_issue', 'tracker_get_issue')
      return tracker_get_issue({ pluginId: 'jira', key: ticketId })
    },

    jira_post_comment: async ({ ticketId, body }: { ticketId: string; body: string }) => {
      logDeprecation(ctx, 'jira_post_comment', 'tracker_comment_issue')
      return tracker_comment_issue({ pluginId: 'jira', key: ticketId, body })
    },

    jira_transition_issue: async ({ ticketId, transitionId }: { ticketId: string; transitionId: string }) => {
      logDeprecation(ctx, 'jira_transition_issue', 'tracker_transition_issue')
      // The legacy contract took a Jira transition *id*; the plugin's
      // tracker contract takes a *status name*. Pass the value
      // through as the status string — Jira projects with numeric
      // transition ids in workflow markdown will need to migrate at
      // P9, but the call still goes to Jira and the runner emits a
      // structured tool error if Jira rejects an unknown transition.
      return tracker_transition_issue({ pluginId: 'jira', key: ticketId, status: transitionId })
    },

    // Work-item tracking — pure state CRUD, zero orchestration logic
    set_work_items: setWorkItems,
    update_work_item: updateWorkItem,
    get_work_items: getWorkItems,

    request_new_session: async ({ reason }: { reason: string }) => {
      await ctx.stateBackend.updateJob(ctx.job.id, { sessionId: undefined })
      ctx.job = await ctx.stateBackend.getJob(ctx.job.id) as Job
      await ctx.stateBackend.appendLog(ctx.job.id, `[session-reset] ${reason}`)
      return text({ newSession: true, reason })
    },

    set_job_params: async ({ params }: { params: Record<string, unknown> }) => {
      const job = await ctx.stateBackend.getJob(ctx.job.id) as Job
      const merged = { ...job.params, ...params }
      await ctx.stateBackend.updateJob(ctx.job.id, { params: merged })
      ctx.job = await ctx.stateBackend.getJob(ctx.job.id) as Job
      return text({ updated: Object.keys(params) })
    },

    // Job control
    goto_phase: async ({ phase }: { phase: string }) => {
      signals.nextPhase = phase
      return text({ goingToPhase: phase })
    },

    await_event: async ({ eventName, prId }: { eventName: string; prId?: number }) => {
      signals.awaitingEvent = eventName
      signals.awaitingPrId = prId
      return text({ awaiting: eventName, prId: prId ?? null })
    },

    escalate: async ({ reason }: { reason: string }) => {
      const { STATUS_ESCALATED } = await import('./jobs/types')
      await ctx.stateBackend.updateJob(ctx.job.id, {
        status: STATUS_ESCALATED,
        escalationMessage: reason,
      })
      signals.escalated = true
      signals.escalationReason = reason
      ctx.logger.warn({ jobId: ctx.job.id, reason }, 'Job escalated')
      return text({ escalated: true, reason })
    },

    add_insight: async ({ category, summary, detail, suggestion }: {
      category: string; summary: string; detail: string; suggestion?: string
    }) => {
      const job = await ctx.stateBackend.getJob(ctx.job.id) as Job
      const insight: Insight = {
        phase: job.phase,
        category,
        summary,
        detail,
        ...(suggestion ? { suggestion } : {}),
      }
      const insights = [...(job.insights ?? []), insight]
      await ctx.stateBackend.updateJob(ctx.job.id, { insights })
      ctx.job = await ctx.stateBackend.getJob(ctx.job.id) as Job
      await ctx.stateBackend.appendLog(ctx.job.id, `[insight] ${category}: ${summary}`)
      return text({ recorded: true, totalInsights: insights.length })
    },

    log: async ({ message }: { message: string }) => {
      await ctx.stateBackend.appendLog(ctx.job.id, message)
      return text(null)
    },

    // Artefacts — generic per-phase outputs that the dashboard knows how to render
    post_artifact: async ({ phase, kind, title, data }: {
      phase?: string; kind: string; title: string; data?: Record<string, unknown>
    }) => {
      const job = await ctx.stateBackend.getJob(ctx.job.id) as Job
      const now = new Date()
      const rand = Math.random().toString(36).slice(2, 8)
      const artifact: Artifact = {
        id: `art-${now.getTime()}-${rand}`,
        phase: phase ?? job.phase,
        kind,
        title,
        data: data ?? {},
        createdBy: job.currentWorkItem ? `${job.phase}:${job.currentWorkItem}` : job.phase,
        createdAt: now.toISOString(),
      }
      const artifacts = [...(job.artifacts ?? []), artifact]
      await ctx.stateBackend.updateJob(ctx.job.id, { artifacts })
      ctx.job = await ctx.stateBackend.getJob(ctx.job.id) as Job
      await ctx.stateBackend.appendLog(ctx.job.id, `[artifact] ${artifact.phase}/${kind}: ${title}`)
      return text({ id: artifact.id, phase: artifact.phase, kind, title })
    },

    get_artifacts: async ({ phase }: { phase?: string }) => {
      const job = await ctx.stateBackend.getJob(ctx.job.id) as Job
      const all = job.artifacts ?? []
      const filtered = phase ? all.filter(a => a.phase === phase) : all
      return text({ artifacts: filtered, total: filtered.length })
    },

    // Self-improvement
    propose_change: async (args: {
      type:
        | 'new-tool' | 'modify-tool' | 'new-workflow' | 'modify-workflow'
        | 'new-agent' | 'modify-agent' | 'memory-update'
        | 'skill-create' | 'skill-update' | 'claude-md-update'
      title: string
      rationale: string
      description: string
      files?: Array<{ path: string; content: string }>
      /**
       * Structured short-form memory entries. Preferred for memory-update
       * proposals — the runner serialises each entry into a fixed layout
       * and rejects entries that exceed the per-kind line budget.
       */
      entries?: Array<{
        file: string
        kind: 'pitfall' | 'pattern'
        title: string
        symptom?: string
        rootCause?: string
        recipe?: string
        antiPattern?: string
        whenToUse?: string
      }>
      targetFile?: string
      proposedContent?: string
      targetLayer?: 'tenant' | 'repo'
    }) => {
      const { proposeChange } = await import('./tools/self-improvement')
      try {
        const result = await proposeChange({
          type: args.type,
          title: args.title,
          rationale: args.rationale,
          description: args.description,
          files: args.files,
          entries: args.entries,
          targetFile: args.targetFile,
          proposedContent: args.proposedContent,
          targetLayer: args.targetLayer,
        }, ctx)
        return text(result)
      } catch (err) {
        // Surface validation / git / PR errors as a structured tool
        // error so the agent can correct and retry rather than the
        // SDK swallowing the rejection.
        return error((err as Error).message)
      }
    },

    list_proposals: async (args: { limit?: number; type?: string; status?: 'pending' | 'approved' | 'rejected' }) => {
      const { listProposals } = await import('./tools/self-improvement')
      const result = await listProposals(
        { limit: args.limit, type: args.type, ...(args.status ? { status: args.status } : {}) },
        ctx,
      )
      return text(result)
    },

    // Campaign coordination — promotes a regular planning job into a
    // campaign, registers child issues, and exposes live-control mutations.
    // Implementation lives in `tools/campaign.ts`.
    convert_to_campaign: async (args: {
      title: string
      description: string
      trackerEpicRef?: { provider: 'jira' | 'github' | 'linear'; key: string; url: string }
    }) => {
      const { convertToCampaign } = await import('./tools/campaign')
      try {
        const result = await convertToCampaign(args, ctx, signals)
        return text(result)
      } catch (err) {
        return error((err as Error).message)
      }
    },

    campaign_register_child: async (args: {
      name: string
      description: string
      params?: Record<string, unknown>
      dependsOn?: string[]
      trackerRef?: { provider: 'jira' | 'github' | 'linear'; key: string; url: string }
    }) => {
      const { campaignRegisterChild } = await import('./tools/campaign')
      try {
        const result = await campaignRegisterChild(args, ctx)
        return text(result)
      } catch (err) {
        return error((err as Error).message)
      }
    },

    campaign_finalize: async () => {
      const { campaignFinalize } = await import('./tools/campaign')
      try {
        const result = await campaignFinalize(ctx, signals)
        return text(result)
      } catch (err) {
        return error((err as Error).message)
      }
    },

    campaign_status: async () => {
      const { campaignStatus } = await import('./tools/campaign')
      try {
        const result = await campaignStatus(ctx)
        return text(result)
      } catch (err) {
        return error((err as Error).message)
      }
    },

    campaign_skip_child: async (args: { name: string; reason?: string }) => {
      const { campaignSkipChild } = await import('./tools/campaign')
      try {
        const result = await campaignSkipChild(args, ctx)
        return text(result)
      } catch (err) {
        return error((err as Error).message)
      }
    },

    campaign_rerun_child: async (args: { name: string; reason?: string }) => {
      const { campaignRerunChild } = await import('./tools/campaign')
      try {
        const result = await campaignRerunChild(args, ctx)
        return text(result)
      } catch (err) {
        return error((err as Error).message)
      }
    },

    campaign_cancel_child: async (args: { name: string; reason?: string }) => {
      const { campaignCancelChild } = await import('./tools/campaign')
      try {
        const result = await campaignCancelChild(args, ctx)
        return text(result)
      } catch (err) {
        return error((err as Error).message)
      }
    },

    // On-demand memory access. The system prompt no longer carries the memory
    // bundle — agents pull what they need via this tool. Zero args returns the
    // index + every file linked from it + any pending on-disk proposals; pass
    // a specific relative path (e.g. "known-pitfalls.md") to fetch a single
    // file without the rest.
    read_memory: async (args: { file?: string }) => {
      const fs = await import('fs/promises')
      const nodePath = await import('path')
      const memoryDir = nodePath.join(ctx.settings.paths.coroIntelligenceDir, 'memory')

      const readFile = async (rel: string): Promise<string | null> => {
        try {
          return await fs.readFile(nodePath.join(memoryDir, rel), 'utf-8')
        } catch {
          return null
        }
      }

      if (args.file) {
        const content = await readFile(args.file)
        if (content === null) return error(`memory file not found: ${args.file}`)
        return text({ file: args.file, content })
      }

      const index = await readFile('MEMORY.md')
      if (index === null) {
        return text({ index: null, files: [], proposals: [] })
      }

      const linkRe = /\[[^\]]*\]\(([^)]+)\)/g
      const linkedFiles: Array<{ path: string; content: string }> = []
      const seen = new Set<string>()
      let match: RegExpExecArray | null
      while ((match = linkRe.exec(index)) !== null) {
        const href = match[1].split(/[?#]/)[0]
        if (!href || href.startsWith('http') || href.startsWith('#') || seen.has(href)) continue
        seen.add(href)
        const c = await readFile(href)
        if (c !== null) linkedFiles.push({ path: href, content: c })
      }

      // Pending proposals come from the state backend now (PRs against
      // the tenant or project repo are the source of truth). Surface them
      // here so agents reading memory also see what is in flight.
      const pendingRecords = await ctx.stateBackend.listProposals(
        ctx.tenantContext.tenantId,
        'pending',
      )
      const proposals = pendingRecords.map(p => ({
        id: p.id,
        type: p.type,
        title: p.title,
        rationale: p.rationale,
        targetLayer: p.targetLayer,
        prUrl: p.prUrl,
        branch: p.branch,
        files: p.files.map(f => f.path),
      }))

      return text({ index, files: linkedFiles, proposals })
    },
  }
}

export type McpToolHandlers = ReturnType<typeof createMcpToolHandlers>
