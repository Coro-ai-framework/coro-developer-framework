import * as fs from 'fs/promises'
import * as path from 'path'
import { createIsolatedGit, installRepoGitAuth, persistableCloneUrl } from './clients/git-auth'
import { ToolContext, PhaseSignals } from './tools/types'
import { Artifact, WorkItem, Insight, Job } from '@coro-ai/cloud-protocol'
import type { ExternalRef } from '@coro-ai/cloud-protocol'
import type { ScmPluginRuntime, TrackerPluginRuntime } from './plugins/types'
import { PluginResolutionError } from './plugins/registry'
import {
  buildGuardrailContext,
  createGuardrailEngine,
  createGuardrailScmDeps,
} from './guardrails'
import { loadLocalConfig } from './config/local-config'
import type {
  DispatchImprovementJobArgs,
  UpstreamCommentIssueArgs,
  UpstreamCreateIssueArgs,
  UpstreamSearchArgs,
} from './tools/upstream'

// ── Response helpers (shared with MCP server wiring) ──────────────────────────

export function mcpText(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

export function mcpError(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], isError: true as const }
}

/**
 * Wrap every handler returned by {@link createMcpToolHandlers} in a
 * try/catch that converts unhandled throws into a structured
 * {@link mcpError} response.
 *
 * Without this safety net, a thrown exception inside a tool callback
 * propagates out of the SDK's in-process MCP transport and tears it
 * down — every subsequent tool invocation in the same session then
 * returns a generic "Stream closed" error and the agent gives up. The
 * extension-tool registration in `mcp-server.ts` already wraps its
 * handlers the same way; this helper extends the same guarantee to
 * the native `scm_*` / `tracker_*` / etc. handlers so any plugin or
 * client error surfaces as a recoverable tool error rather than a
 * transport crash.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function wrapHandlersSafely<T extends Record<string, (...args: any[]) => any>>(handlers: T): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Record<string, (...args: any[]) => any> = {}
  for (const [name, fn] of Object.entries(handlers)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    out[name] = async (...args: any[]) => {
      try {
        return await (fn as (...a: unknown[]) => unknown)(...args)
      } catch (err) {
        return mcpError(`${name} failed: ${(err as Error).message ?? String(err)}`)
      }
    }
  }
  return out as T
}

const CLONE_HEARTBEAT_MS = 15_000

function formatCloneBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${Math.round(bytes / (1024 * 1024))}MB`
}

/** Size of `.git/objects/pack`, including the in-flight `tmp_pack_*`. */
async function clonePackBytes(repoDir: string): Promise<number> {
  const packDir = path.join(repoDir, '.git', 'objects', 'pack')
  try {
    const names = await fs.readdir(packDir)
    let total = 0
    for (const name of names) {
      const st = await fs.stat(path.join(packDir, name)).catch(() => null)
      if (st?.isFile()) total += st.size
    }
    return total
  } catch {
    return 0
  }
}

/**
 * `git clone --filter=blob:none` finishes the commit/tree pack, then
 * fetches HEAD blobs with an inner `git fetch` that has no `--progress`.
 * simple-git therefore sees no stdio and a block timeout looks like a hang.
 * Log pack growth so the job stream stays alive; network stalls are
 * already killed by `http.lowSpeed*`.
 */
function startCloneHeartbeat(
  appendLog: (jobId: string, line: string) => Promise<unknown>,
  jobId: string,
  repo: string,
  repoDir: string,
): () => void {
  const timer = setInterval(() => {
    void clonePackBytes(repoDir).then(bytes => {
      void appendLog(
        jobId,
        `[repo-clone] ${repo} still running (${formatCloneBytes(bytes)} on disk)`,
      )
    })
  }, CLONE_HEARTBEAT_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

// ── Plugin resolution helpers ────────────────────────────────────────────────
//
// `scm_*` and `tracker_*` handlers all need the same boilerplate: pick
// the per-job-or-explicit plugin, surface a structured MCP error when
// resolution fails so the agent can re-call with a corrected
// `pluginId`. Centralised here so each tool stays a one-liner that
// just dispatches to the chosen plugin's method.
//
// After the MCP-first pivot, the proxy operates in one of two modes
// per (plugin, op):
//
//   1. **Native mode** — the plugin keeps its concrete method
//      (BitBucket today). The handler calls the method and returns
//      its result. No MCP server is involved.
//
//   2. **MCP-mode redirect** — the plugin delegates to an upstream
//      MCP server attached at job start (github / jira / linear /
//      github-issues today). The Claude Agent SDK does not expose a
//      programmatic MCP client we can call from inside a handler, so
//      we return a structured `mcp__<pluginId>__<upstream-tool>`
//      pointer for the agent to invoke directly on its next turn.
//      The agent already has those tools attached (S1) — the
//      redirect costs one round-trip and avoids spawning the
//      upstream MCP server twice.
//
// `mcpRedirect` formats the redirect consistently. The exact upstream
// tool name comes from the plugin manifest's `mcpToolMap` so each
// plugin owns its own naming.

function mcpRedirect(
  pluginId: string,
  proxyOp: string,
  upstreamTool: string | undefined,
  args: Record<string, unknown>,
) {
  if (!upstreamTool) {
    return mcpError(
      `Plugin "${pluginId}" has an MCP server but no \`mcpToolMap[${proxyOp}]\`. ` +
      `Either add the mapping to the plugin manifest or call the upstream tool ` +
      `directly via \`mcp__${pluginId}__<tool-name>\`.`,
    )
  }
  // The shape mimics a standard MCP error so the agent's prompt-side
  // error-handling logic (built into Claude Code) classifies the
  // redirect as a "use this other tool" hint rather than a hard fail.
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        redirect: true,
        message:
          `Generic proxy "${proxyOp}" delegates to the active plugin's MCP server. ` +
          `Call \`mcp__${pluginId}__${upstreamTool}\` directly with the args below — ` +
          `the upstream MCP server is already attached to this session.`,
        upstreamTool: `mcp__${pluginId}__${upstreamTool}`,
        upstreamArgs: args,
      }, null, 2),
    }],
    isError: true as const,
  }
}

function resolveScm(
  ctx: ToolContext,
  pluginId?: string,
  repoUrl?: string,
): { ok: true; scm: ScmPluginRuntime } | { ok: false; error: ReturnType<typeof mcpError> } {
  try {
    // (1) Explicit pluginId from the agent always wins.
    if (pluginId) {
      const scm = ctx.plugins.resolveScm({ scm: pluginId })
      return { ok: true, scm }
    }
    // (2) Disambiguate by the repo URL the agent is acting on. This
    // prevents a github URL from being routed to the bitbucket plugin
    // (or vice versa) when both are installed and the registry default
    // points the wrong way — the same class of bug that broke PR
    // polling.
    if (repoUrl && typeof repoUrl === 'string' && repoUrl.includes('://')) {
      const matched = ctx.plugins.resolveByRemote(repoUrl)
      if (matched) return { ok: true, scm: matched }
    }
    // (3) Fall back to the job's `params.scm`, then the registry default.
    const requested = typeof ctx.job.params['scm'] === 'string' ? (ctx.job.params['scm'] as string) : undefined
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
 * All Coro MCP tool implementations. Used by `createCoroMcpServer` and by tests
 * that invoke handlers with a mock {@link ToolContext}.
 *
 * The legacy `bb_*` / `gh_*` / `jira_*` shims and their
 * `logDeprecation` gate were removed in S6 of the MCP-first plugins
 * pivot. The deprecation cycle controller in `plugins/deprecation.ts`
 * still ships for *config* keys (`legacyConfigKeysBehaviour`) and the
 * *mapping tables* (`legacyMappingTablesBehaviour`); only the MCP
 * wrapper branch graduated past N+2 ahead of cycle because the
 * plugins migration replaced every legacy call site at once.
 */
/** Persist repo checkout paths on the job after clone/reuse for prompt and kickoff. */
async function persistRepoCheckoutParams(
  ctx: ToolContext,
  repoCheckoutDir: string,
  repoCheckoutAbsDir: string,
): Promise<void> {
  const updated = await ctx.stateBackend.updateJob(ctx.job.id, {
    params: {
      ...ctx.job.params,
      repoCheckoutDir,
      repoCheckoutAbsDir,
    },
  })
  ctx.job = updated
}

export function createMcpToolHandlers(ctx: ToolContext, signals: PhaseSignals) {
  const text = mcpText
  const error = mcpError
  const guardrailEngine = createGuardrailEngine(loadLocalConfig(), {
    scm: createGuardrailScmDeps(ctx),
    activityLog: line => ctx.stateBackend.appendLog(ctx.job.id, line),
  })

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
  // After the MCP-first pivot (S4), the agent-facing surface is
  // trimmed to 7 tools (5 PR ops + clone-info + clone-repo):
  //   - scm_create_pr
  //   - scm_get_pr_status
  //   - scm_list_pr_comments
  //   - scm_post_pr_comment
  //   - scm_merge_pr
  //   - scm_get_clone_info
  //   - scm_clone_repo
  //
  // Removed: scm_create_repo, scm_approve_pr, scm_reply_to_comment,
  // scm_poll_pr — agents call native `mcp__<pluginId>__*` tools for
  // those (the upstream MCP servers cover them). `pollPr` moves out
  // of the agent surface entirely; only the polling transport calls
  // it on the runner-side.

  const scm_create_pr = async (args: {
    pluginId?: string
    repo: string
    title: string
    description?: string
    sourceBranch: string
    sourceOwner?: string
    targetBranch?: string
    reviewers?: string[]
  }) => {
    const jobDir = jobWorkingDir()
    const guardCtx = buildGuardrailContext({
      on: 'scm.create_pr',
      toolName: 'mcp__coro__scm_create_pr',
      toolInput: args as unknown as Record<string, unknown>,
      job: ctx.job,
      workingDir: jobDir,
    })
    const guardDecision = await guardrailEngine.evaluate('scm.create_pr', guardCtx)
    if (!guardDecision.allow) {
      return mcpError(guardDecision.reason ?? 'Guardrail blocked scm_create_pr.')
    }

    const r = resolveScm(ctx, args.pluginId, args.repo)
    if (!r.ok) return r.error
    const { jobReviewers } = await import('./jobs/helpers')
    const targetBranch = args.targetBranch ?? 'main'
    const reviewers = args.reviewers ?? jobReviewers(ctx.job)
    if (!r.scm.createPr) {
      // MCP-mode plugin (e.g. github). Redirect the agent at the
      // upstream tool. The mapping comes from the plugin manifest.
      return mcpRedirect(r.scm.manifest.id, 'scm_create_pr',
        r.scm.manifest.mcpToolMap?.scm_create_pr,
        {
          repo: args.repo,
          title: args.title,
          ...(args.description ? { body: args.description } : {}),
          // Cross-repository PRs are expressed as `owner:branch` in the
          // GitHub API, and the upstream MCP tools follow that spelling.
          head: args.sourceOwner ? `${args.sourceOwner}:${args.sourceBranch}` : args.sourceBranch,
          base: targetBranch,
          ...(reviewers.length ? { reviewers } : {}),
        },
      )
    }
    // Persisted by `scm_clone_repo`. Providers that host the branch remotely
    // ignore it; the local provider pushes from it.
    const sourceCheckoutDir = ctx.job.params['repoCheckoutAbsDir']
    const ref = await r.scm.createPr({
      repoSlug: args.repo,
      title: args.title,
      ...(args.description ? { description: args.description } : {}),
      sourceBranch: args.sourceBranch,
      ...(args.sourceOwner ? { sourceOwner: args.sourceOwner } : {}),
      targetBranch,
      reviewers,
      ...(typeof sourceCheckoutDir === 'string' && sourceCheckoutDir
        ? { sourceCheckoutDir }
        : {}),
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
    const r = resolveScm(ctx, args.pluginId, args.repo)
    if (!r.ok) return r.error
    if (!r.scm.getPrStatus) {
      return mcpRedirect(r.scm.manifest.id, 'scm_get_pr_status',
        r.scm.manifest.mcpToolMap?.scm_get_pr_status,
        { repo: args.repo, pull_number: Number(args.prId) },
      )
    }
    const status = await r.scm.getPrStatus(prRef(r.scm, args.repo, args.prId))
    return text(status)
  }

  const scm_list_pr_comments = async (args: { pluginId?: string; repo: string; prId: number | string }) => {
    const r = resolveScm(ctx, args.pluginId, args.repo)
    if (!r.ok) return r.error
    if (!r.scm.listPrComments) {
      return mcpRedirect(r.scm.manifest.id, 'scm_list_pr_comments',
        r.scm.manifest.mcpToolMap?.scm_list_pr_comments,
        { repo: args.repo, pull_number: Number(args.prId) },
      )
    }
    const comments = await r.scm.listPrComments(prRef(r.scm, args.repo, args.prId))
    return text(comments)
  }

  const scm_post_pr_comment = async (args: {
    pluginId?: string; repo: string; prId: number | string; body: string
  }) => {
    const r = resolveScm(ctx, args.pluginId, args.repo)
    if (!r.ok) return r.error
    if (!r.scm.postPrComment) {
      return mcpRedirect(r.scm.manifest.id, 'scm_post_pr_comment',
        r.scm.manifest.mcpToolMap?.scm_post_pr_comment,
        { repo: args.repo, issue_number: Number(args.prId), body: args.body },
      )
    }
    const comment = await r.scm.postPrComment(prRef(r.scm, args.repo, args.prId), args.body)
    return text(comment)
  }

  const scm_reply_to_comment = async (args: {
    pluginId?: string; repo: string; prId: number | string; parentCommentId: number | string; body: string
  }) => {
    const r = resolveScm(ctx, args.pluginId, args.repo)
    if (!r.ok) return r.error
    if (!r.scm.replyToComment) {
      // MCP-mode plugin (e.g. github). Redirect to the upstream
      // threaded-reply tool. Pass both `comment_id`/`in_reply_to`
      // shapes so the redirect hint works regardless of which arg
      // the upstream server names.
      return mcpRedirect(r.scm.manifest.id, 'scm_reply_to_comment',
        r.scm.manifest.mcpToolMap?.scm_reply_to_comment,
        {
          repo: args.repo,
          pull_number: Number(args.prId),
          comment_id: args.parentCommentId,
          in_reply_to: args.parentCommentId,
          body: args.body,
        },
      )
    }
    const comment = await r.scm.replyToComment(
      prRef(r.scm, args.repo, args.prId),
      String(args.parentCommentId),
      args.body,
    )
    return text(comment)
  }

  const scm_add_pr_reviewers = async (args: {
    pluginId?: string; repo: string; prId: number | string; reviewers: string[]
  }) => {
    const r = resolveScm(ctx, args.pluginId, args.repo)
    if (!r.ok) return r.error
    if (!args.reviewers || args.reviewers.length === 0) {
      return error('reviewers must be a non-empty array of usernames or uuids')
    }
    if (!r.scm.addReviewers) {
      // MCP-mode plugin (e.g. github). Redirect to the upstream tool
      // when the plugin manifest exposes a mapping; otherwise surface
      // a clear "not supported" error so the agent stops looking.
      const mapped = r.scm.manifest.mcpToolMap?.scm_add_pr_reviewers
      if (mapped) {
        return mcpRedirect(r.scm.manifest.id, 'scm_add_pr_reviewers', mapped, {
          repo: args.repo,
          pull_number: Number(args.prId),
          reviewers: args.reviewers,
        })
      }
      return error(
        `SCM plugin "${r.scm.manifest.id}" does not support adding reviewers to an existing PR. ` +
        'Post a PR comment tagging the reviewer instead.',
      )
    }
    await r.scm.addReviewers({
      repoSlug: args.repo,
      prId: args.prId,
      reviewers: args.reviewers,
    })
    return text({ added: args.reviewers.length })
  }

  const scm_resolve_user = async (args: { pluginId?: string; repo?: string; query: string }) => {
    const r = resolveScm(ctx, args.pluginId, args.repo)
    if (!r.ok) return r.error
    if (!r.scm.resolveUser) {
      return error(
        `SCM plugin "${r.scm.manifest.id}" does not support resolving users. ` +
        `Pass the user's UUID, account_id, or login directly to scm_add_pr_reviewers.`,
      )
    }
    const q = (args.query ?? '').trim()
    if (!q) return error('query is required')
    const match = await r.scm.resolveUser(q)
    if (!match) {
      return text({
        matched: false,
        query: q,
        hint:
          'No workspace member matched. If you have an email address, look up the user in your tracker first ' +
          '(e.g. mcp__jira__jira_get_user_profile) — the Atlassian accountId is identical to the Bitbucket ' +
          'account_id and can be passed directly to scm_add_pr_reviewers.',
      })
    }
    return text({ matched: true, query: q, user: match })
  }

  const scm_merge_pr = async (args: {
    pluginId?: string; repo: string; prId: number | string; message?: string; strategy?: 'merge' | 'squash' | 'rebase'
  }) => {
    const jobDir = jobWorkingDir()
    const guardCtx = buildGuardrailContext({
      on: 'scm.merge_pr',
      toolName: 'mcp__coro__scm_merge_pr',
      toolInput: args as unknown as Record<string, unknown>,
      job: ctx.job,
      workingDir: jobDir,
    })
    const guardDecision = await guardrailEngine.evaluate('scm.merge_pr', guardCtx)
    if (!guardDecision.allow) {
      return mcpError(guardDecision.reason ?? 'Guardrail blocked scm_merge_pr.')
    }

    const r = resolveScm(ctx, args.pluginId, args.repo)
    if (!r.ok) return r.error
    if (!r.scm.mergePr) {
      return mcpRedirect(r.scm.manifest.id, 'scm_merge_pr',
        r.scm.manifest.mcpToolMap?.scm_merge_pr,
        {
          repo: args.repo,
          pull_number: Number(args.prId),
          ...(args.message ? { commit_message: args.message } : {}),
          ...(args.strategy ? { merge_method: args.strategy } : {}),
        },
      )
    }
    await r.scm.mergePr(
      prRef(r.scm, args.repo, args.prId),
      {
        ...(args.message ? { message: args.message } : {}),
        ...(args.strategy ? { strategy: args.strategy } : {}),
      },
    )

    // Stamp `mergedAt` on the matching prMappings entry so the
    // completion gate, dashboard, and any agent that re-reads
    // `job.prMappings` can see which PRs are still open vs merged
    // without re-querying the SCM. This used to only happen on the
    // cloud WebSocket merge path (`job:prMerged`), leaving local-mode
    // jobs with stale mappings.
    const prIdNumber = Number(args.prId)
    if (Number.isFinite(prIdNumber)) {
      try {
        await ctx.stateBackend.markPrMerged(
          ctx.job.id,
          prIdNumber,
          new Date().toISOString(),
        )
      } catch (err) {
        // Soft-fail: the merge itself already succeeded. A bookkeeping
        // failure (no mapping for this PR, race with another writer,
        // etc.) must not surface as a tool error to the agent.
        ctx.logger.warn(
          { err, jobId: ctx.job.id, prId: prIdNumber },
          'markPrMerged failed after successful scm_merge_pr',
        )
      }
    }

    return text({ merged: true })
  }

  const scm_get_clone_info = async (args: { pluginId?: string; repo: string }) => {
    const r = resolveScm(ctx, args.pluginId, args.repo)
    if (!r.ok) return r.error
    const info = r.scm.cloneInfo({ repo: args.repo })
    return text({
      pluginId: r.scm.manifest.id,
      url: persistableCloneUrl(info),
      envForGit: info.envForGit,
      auth: info.username || info.password
        ? 'injected by the job git credential helper — do not put tokens in remotes'
        : 'none',
    })
  }

  const scm_clone_repo = async (args: { pluginId?: string; repo: string }) => {
    const r = resolveScm(ctx, args.pluginId, args.repo)
    if (!r.ok) return r.error

    const repo = args.repo.trim()
    if (!repo) return error('repo is required')

    const info = r.scm.cloneInfo({ repo })
    if (!info.url) {
      return error(`scm plugin "${r.scm.manifest.id}" returned an empty clone URL for repo "${repo}"`)
    }

    const jobWorkingDir = path.join(ctx.settings.paths.workingDir, ctx.job.id)
    const repoDir = path.join(jobWorkingDir, repo)

    await fs.mkdir(jobWorkingDir, { recursive: true })

    if (await isGitRepo(repoDir)) {
      if (await cloneLooksIncomplete(repoDir)) {
        await fs.rm(repoDir, { recursive: true, force: true }).catch(() => undefined)
        await ctx.stateBackend.appendLog(
          ctx.job.id,
          `[repo-clone] removing incomplete checkout of ${repo}`,
        )
      } else {
        await installRepoGitAuth(repoDir, { matchesRemote: url => r.scm.matchesRemote(url) })
        await ctx.stateBackend.mapRepoToJob(repo, ctx.job.id)
        await persistRepoCheckoutParams(ctx, repo, repoDir)
        return text({
          pluginId: r.scm.manifest.id,
          repo,
          repoDir,
          relativeDir: repo,
          reused: true,
        })
      }
    }

    const targetStat = await fs.stat(repoDir).catch(() => null)
    if (targetStat) {
      const entries = await fs.readdir(repoDir)
      if (entries.length === 0) {
        await fs.rm(repoDir, { recursive: true, force: true })
      } else {
        return error(
          `Cannot clone repo "${repo}": target path ${repoDir} already exists and is not a git checkout. ` +
          'Remove it or choose a different directory.',
        )
      }
    }

    const persistUrl = persistableCloneUrl(info)
    // `--progress` covers the first pack only. `--filter=blob:none` keeps
    // full commit history without historical blobs; HEAD blobs are then
    // fetched by an inner `git fetch` that has no `--progress`, so
    // simple-git's block timeout would kill a healthy clone. Network
    // stalls are handled by http.lowSpeed*; a disk heartbeat covers the
    // silent blob-fetch / checkout phase.
    let lastProgressKey = ''
    const git = createIsolatedGit(jobWorkingDir, info.envForGit, {
      progress: ({ stage, progress }) => {
        if (typeof progress !== 'number' || !Number.isFinite(progress)) return
        const bucket = Math.min(100, Math.floor(progress / 25) * 25)
        const key = `${stage || 'clone'}:${bucket}`
        if (key === lastProgressKey) return
        lastProgressKey = key
        void ctx.stateBackend.appendLog(
          ctx.job.id,
          `[repo-clone] ${repo} ${stage || 'clone'} ${bucket}%`,
        )
        if ((stage || '') === 'resolving' && bucket === 100) {
          void ctx.stateBackend.appendLog(
            ctx.job.id,
            `[repo-clone] ${repo} fetching working-tree blobs (git prints no % for this step)`,
          )
        }
      },
    })
    // Belt-and-suspenders: even with GIT_CONFIG_GLOBAL/SYSTEM neutered
    // (see createIsolatedGit), an `insteadOf` rule can also live in the
    // repo-local config of a parent worktree we happen to be invoked
    // from. Pass explicit `--config url.https://<host>/.insteadOf=...`
    // for every host we know we issue HTTPS clone URLs against, so any
    // ssh-rewrite rule the operator has is overridden inline by `git`.
    const insteadOfOverrides = [
      'url.https://bitbucket.org/.insteadOf=ssh://git@bitbucket.org/',
      'url.https://bitbucket.org/.insteadOf=git@bitbucket.org:',
      'url.https://github.com/.insteadOf=ssh://git@github.com/',
      'url.https://github.com/.insteadOf=git@github.com:',
      'url.https://gitlab.com/.insteadOf=ssh://git@gitlab.com/',
      'url.https://gitlab.com/.insteadOf=git@gitlab.com:',
    ].flatMap(rule => ['--config', rule])
    const cloneArgs = (filter: boolean) => [
      ...(filter ? ['--filter=blob:none'] : []),
      '--progress',
      ...insteadOfOverrides,
    ]
    const failClone = async (msg: string) => {
      await fs.rm(repoDir, { recursive: true, force: true }).catch(() => undefined)
      await ctx.stateBackend.appendLog(ctx.job.id, `[repo-clone] failed ${repo}: ${msg}`)
      return error(`Clone of "${repo}" failed: ${msg}`)
    }
    await ctx.stateBackend.appendLog(ctx.job.id, `[repo-clone] starting ${repo}`)
    const stopHeartbeat = startCloneHeartbeat(
      (jobId, line) => ctx.stateBackend.appendLog(jobId, line),
      ctx.job.id,
      repo,
      repoDir,
    )
    try {
      try {
        await git.clone(persistUrl, repoDir, cloneArgs(true))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await fs.rm(repoDir, { recursive: true, force: true }).catch(() => undefined)
        if (!/filter|partial clone/i.test(msg)) return failClone(msg)
        await ctx.stateBackend.appendLog(
          ctx.job.id,
          `[repo-clone] partial clone unsupported, retrying full clone of ${repo}`,
        )
        try {
          await git.clone(persistUrl, repoDir, cloneArgs(false))
        } catch (retryErr) {
          return failClone(retryErr instanceof Error ? retryErr.message : String(retryErr))
        }
      }
    } finally {
      stopHeartbeat()
    }
    await installRepoGitAuth(repoDir, { matchesRemote: url => r.scm.matchesRemote(url) })
    await ctx.stateBackend.mapRepoToJob(repo, ctx.job.id)
    await ctx.stateBackend.appendLog(ctx.job.id, `[repo-cloned] ${repo} -> ${repoDir}`)
    await persistRepoCheckoutParams(ctx, repo, repoDir)

    return text({
      pluginId: r.scm.manifest.id,
      repo,
      repoDir,
      relativeDir: repo,
      reused: false,
    })
  }

  // ── Generic Tracker tools ──────────────────────────────────────────────
  //
  // Same idea as scm_*: every tracker plugin implements the same
  // surface; the registry picks one. The legacy `tracker_*` handlers
  // (which went through `ctx.trackerClient`) are replaced by these.

  const tracker_get_issue = async (args: { pluginId?: string; key: string }) => {
    const r = resolveTracker(ctx, args.pluginId)
    if (!r.ok) return r.error
    if (!r.tracker.getIssue) {
      return mcpRedirect(r.tracker.manifest.id, 'tracker_get_issue',
        r.tracker.manifest.mcpToolMap?.tracker_get_issue,
        { issue_key: args.key, key: args.key },
      )
    }
    try {
      const issue = await r.tracker.getIssue(args.key)
      return text(issue)
    } catch (err) {
      return error((err as Error).message)
    }
  }

  const tracker_get_comments = async (args: { pluginId?: string; key: string }) => {
    const r = resolveTracker(ctx, args.pluginId)
    if (!r.ok) return r.error
    if (!r.tracker.getComments) {
      return mcpRedirect(r.tracker.manifest.id, 'tracker_get_comments',
        r.tracker.manifest.mcpToolMap?.tracker_get_comments,
        { issue_key: args.key, key: args.key },
      )
    }
    try {
      const comments = await r.tracker.getComments(args.key)
      return text(comments)
    } catch (err) {
      return error((err as Error).message)
    }
  }

  const tracker_comment_issue = async (args: { pluginId?: string; key: string; body: string; parentId?: string }) => {
    const r = resolveTracker(ctx, args.pluginId)
    if (!r.ok) return r.error
    if (!r.tracker.commentIssue) {
      // Flat MCP-mode providers can't thread; forward the body only.
      // parentId is deliberately dropped here (the upstream tool has no
      // reply field). Providers that support threading (Jira, Linear)
      // implement commentIssue natively and are handled below.
      return mcpRedirect(r.tracker.manifest.id, 'tracker_comment_issue',
        r.tracker.manifest.mcpToolMap?.tracker_comment_issue,
        { issue_key: args.key, key: args.key, body: args.body },
      )
    }
    try {
      await r.tracker.commentIssue({ key: args.key, body: args.body, ...(args.parentId ? { parentId: args.parentId } : {}) })
      return text({ commented: true, key: args.key, ...(args.parentId ? { parentId: args.parentId } : {}) })
    } catch (err) {
      return error((err as Error).message)
    }
  }

  const tracker_transition_issue = async (args: { pluginId?: string; key: string; status: string }) => {
    const r = resolveTracker(ctx, args.pluginId)
    if (!r.ok) return r.error
    if (!r.tracker.transitionIssue) {
      return mcpRedirect(r.tracker.manifest.id, 'tracker_transition_issue',
        r.tracker.manifest.mcpToolMap?.tracker_transition_issue,
        { issue_key: args.key, key: args.key, status: args.status },
      )
    }
    try {
      await r.tracker.transitionIssue({ key: args.key, status: args.status })
      return text({ transitioned: true, key: args.key, status: args.status })
    } catch (err) {
      return error((err as Error).message)
    }
  }

  // ── File / skill tools (Phase 4 of multi-AI plan) ─────────────────────────
  //
  // Provider-agnostic Read/Write/Edit/Glob/Grep/Skill surface for
  // executors that do NOT bring native equivalents. Claude's SDK
  // ships its own Read/Write/Edit/Glob/Grep + Skill tools, so the
  // MCP server only registers these when
  // `executor.capabilities.supportsNativeFileTools === false`.
  //
  // All paths are resolved relative to the per-job working dir
  // (`settings.paths.workingDir/<jobId>`) and a path-traversal guard
  // forces every resolved path to live inside one of the allowed
  // roots: the working dir (read+write) and the materialised
  // intelligence overlay (read-only via `read_skill`).

  const jobWorkingDir = () => path.resolve(ctx.settings.paths.workingDir, ctx.job.id)

  const resolveUnderRoot = (root: string, requested: string): string | null => {
    const resolved = path.resolve(root, requested)
    const rel = path.relative(root, resolved)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null
    return resolved
  }

  const file_read = async ({ path: requested }: { path: string }) => {
    const root = jobWorkingDir()
    const abs = resolveUnderRoot(root, requested)
    if (!abs) return error(`path escapes working dir: ${requested}`)
    const content = await fs.readFile(abs, 'utf8')
    return text({ path: requested, content })
  }

  const file_write = async ({ path: requested, content }: { path: string; content: string }) => {
    const root = jobWorkingDir()
    const abs = resolveUnderRoot(root, requested)
    if (!abs) return error(`path escapes working dir: ${requested}`)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf8')
    return text({ path: requested, bytesWritten: Buffer.byteLength(content, 'utf8') })
  }

  const file_edit = async ({ path: requested, oldStr, newStr }: {
    path: string; oldStr: string; newStr: string
  }) => {
    const root = jobWorkingDir()
    const abs = resolveUnderRoot(root, requested)
    if (!abs) return error(`path escapes working dir: ${requested}`)
    const existing = await fs.readFile(abs, 'utf8')
    // Count occurrences (non-overlapping) for safety. If oldStr is empty,
    // refuse — that would match everywhere.
    if (oldStr.length === 0) return error('oldStr must be non-empty')
    let count = 0
    let idx = 0
    while ((idx = existing.indexOf(oldStr, idx)) !== -1) { count++; idx += oldStr.length }
    if (count === 0) return error(`oldStr not found in ${requested}`)
    if (count > 1) return error(`oldStr matches ${count} times in ${requested}; must be unique`)
    const updated = existing.replace(oldStr, newStr)
    await fs.writeFile(abs, updated, 'utf8')
    return text({ path: requested, replaced: 1 })
  }

  const file_glob = async ({ pattern }: { pattern: string }) => {
    const root = jobWorkingDir()
    const re = globToRegex(pattern)
    const matches: string[] = []
    await walkDir(root, root, async (rel, entry) => {
      if (entry.isFile() && re.test(rel)) matches.push(rel)
    })
    matches.sort()
    return text({ pattern, matches })
  }

  const file_grep = async (
    { pattern, path: subPath, isRegex }: { pattern: string; path?: string; isRegex?: boolean },
  ) => {
    const root = jobWorkingDir()
    const searchRoot = subPath
      ? (resolveUnderRoot(root, subPath) ?? root)
      : root
    if (!searchRoot) return error(`path escapes working dir: ${subPath}`)
    const re = isRegex
      ? new RegExp(pattern)
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const hits: { path: string; line: number; text: string }[] = []
    await walkDir(searchRoot, root, async (rel, entry) => {
      if (!entry.isFile()) return
      let buf: string
      try { buf = await fs.readFile(path.join(root, rel), 'utf8') }
      catch { return }
      const lines = buf.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) hits.push({ path: rel, line: i + 1, text: lines[i] })
      }
    })
    return text({ pattern, isRegex: !!isRegex, hits })
  }

  const read_skill = async ({ name }: { name: string }) => {
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(name)) return error(`invalid skill name: ${name}`)
    const skillPath = path.join(ctx.jobIntelligenceDir, '.claude', 'skills', name, 'SKILL.md')
    try {
      const content = await fs.readFile(skillPath, 'utf8')
      return text({ name, path: skillPath, content })
    } catch {
      return error(`skill not found: ${name}`)
    }
  }

  /**
   * Run a shell command, scoped to the per-job working dir.
   *
   * Gating:
   *   - Only registered when the executor lacks a native shell tool
   *     (Claude Code SDK ships `Bash`; OpenAI executor does not).
   *   - `cwd` is resolved relative to the job's working dir and must
   *     not escape it. We do NOT try to parse the command itself —
   *     working-dir scoping is the boundary, mirroring how plugin
   *     MCP servers are trusted within their own sandbox.
   *   - Wall-clock timeout (default 120s, hard ceiling 600s) enforced
   *     via `child_process.spawn` + AbortController.
   *   - Output is capped at 64 KiB per stream; truncation is reported
   *     in the response so the model can re-run with narrower scope.
   */
  const shell = async (
    { command, cwd: requestedCwd, timeoutMs }:
    { command: string; cwd?: string; timeoutMs?: number },
  ) => {
    if (typeof command !== 'string' || command.trim().length === 0) {
      return error('command must be a non-empty string')
    }
    const root = jobWorkingDir()
    const cwdAbs = requestedCwd ? resolveUnderRoot(root, requestedCwd) : root
    if (!cwdAbs) return error(`cwd escapes working dir: ${requestedCwd}`)
    try {
      const stat = await fs.stat(cwdAbs)
      if (!stat.isDirectory()) return error(`cwd is not a directory: ${requestedCwd ?? '.'}`)
    } catch {
      return error(`cwd does not exist: ${requestedCwd ?? '.'}`)
    }

    const HARD_TIMEOUT_MS = 600_000
    const DEFAULT_TIMEOUT_MS = 120_000
    const MAX_OUTPUT_BYTES = 64 * 1024
    const effectiveTimeout = Math.min(
      Math.max(1_000, typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS),
      HARD_TIMEOUT_MS,
    )

    const { spawn } = await import('child_process')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), effectiveTimeout)

    try {
      const child = spawn('sh', ['-c', command], {
        cwd: cwdAbs,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        signal: controller.signal,
      })

      const collect = (stream: NodeJS.ReadableStream): Promise<{ data: string; truncated: boolean }> => {
        return new Promise(resolve => {
          const chunks: Buffer[] = []
          let total = 0
          let truncated = false
          stream.on('data', (chunk: Buffer) => {
            if (truncated) return
            const remaining = MAX_OUTPUT_BYTES - total
            if (chunk.length <= remaining) {
              chunks.push(chunk)
              total += chunk.length
            } else {
              chunks.push(chunk.subarray(0, remaining))
              total = MAX_OUTPUT_BYTES
              truncated = true
            }
          })
          stream.on('end', () => resolve({ data: Buffer.concat(chunks).toString('utf8'), truncated }))
          stream.on('error', () => resolve({ data: Buffer.concat(chunks).toString('utf8'), truncated }))
        })
      }

      const [stdoutResult, stderrResult, exit] = await Promise.all([
        collect(child.stdout!),
        collect(child.stderr!),
        new Promise<{ code: number | null; signal: NodeJS.Signals | null; aborted: boolean }>(resolve => {
          child.on('close', (code, signal) => resolve({ code, signal, aborted: controller.signal.aborted }))
          child.on('error', () => resolve({ code: null, signal: null, aborted: controller.signal.aborted }))
        }),
      ])

      const result: Record<string, unknown> = {
        command,
        cwd: requestedCwd ?? '.',
        exitCode: exit.code,
        stdout: stdoutResult.data,
        stderr: stderrResult.data,
      }
      if (stdoutResult.truncated) result.stdoutTruncated = true
      if (stderrResult.truncated) result.stderrTruncated = true
      if (exit.signal) result.signal = exit.signal
      if (exit.aborted) {
        result.timedOut = true
        result.timeoutMs = effectiveTimeout
      }
      return text(result)
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    // ── Generic surface (preferred, post-pivot) ────────
    //
    // SCM:
    scm_create_pr,
    scm_get_pr_status,
    scm_list_pr_comments,
    scm_post_pr_comment,
    scm_reply_to_comment,
    scm_add_pr_reviewers,
    scm_resolve_user,
    scm_merge_pr,
    scm_get_clone_info,
    scm_clone_repo,
    // Tracker:
    tracker_get_issue,
    tracker_get_comments,
    tracker_comment_issue,
    tracker_transition_issue,
    // File / skill (Phase 4 — registered only when executor lacks native equivalents):
    file_read,
    file_write,
    file_edit,
    file_glob,
    file_grep,
    read_skill,
    shell,

    // ── Legacy bb_*/gh_*/jira_* shims removed in S6 ──────────────────────
    //
    // The MCP-first pivot deleted every back-compat wrapper. Workflow
    // markdown that still names a legacy tool now hits the SDK's
    // "tool not found" path, which surfaces a clean error to the
    // agent. Agents must call the trimmed generic surface
    // (`scm_*`/`tracker_*`) or the upstream MCP server directly
    // (`mcp__github__*`, `mcp__jira__*`, …).
    //
    // The deprecation-cycle controller in `plugins/deprecation.ts`
    // still ships for the *config* keys (`legacyConfigKeysBehaviour`)
    // and the mapping tables (`legacyMappingTablesBehaviour`); only
    // the MCP-wrapper branch has been graduated past N+2 ahead of
    // the cycle because the plugins migration replaced all the
    // legacy call sites.

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

    // (Legacy jira_*/bb_*/gh_* shims removed in S6 — see comment above.)

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
      const declared = ctx.declaredPhases
      if (declared?.length && !declared.includes(phase)) {
        return mcpError(
          `goto_phase: '${phase}' is not declared in this workflow. ` +
            `Valid phases: ${declared.join(', ')}`,
        )
      }
      signals.nextPhase = phase
      return text({ goingToPhase: phase })
    },

    await_event: async ({ eventName, prId }: { eventName: string; prId?: number | string }) => {
      const parsed = prId === undefined ? undefined : Number(prId)
      if (parsed !== undefined && !Number.isFinite(parsed)) {
        return mcpError(`await_event: prId "${String(prId)}" is not a number.`)
      }
      signals.awaitingEvent = eventName
      signals.awaitingPrId = parsed
      return text({ awaiting: eventName, prId: parsed ?? null })
    },

    escalate: async ({ reason }: { reason: string }) => {
      const { STATUS_ESCALATED } = await import('@coro-ai/cloud-protocol')
      await ctx.stateBackend.updateJob(ctx.job.id, {
        status: STATUS_ESCALATED,
        escalationMessage: reason,
      })
      signals.escalated = true
      signals.escalationReason = reason
      ctx.logger.warn({ jobId: ctx.job.id, reason }, 'Job escalated')
      return text({ escalated: true, reason })
    },

    add_insight: async ({ category, summary, detail, suggestion, suggestedLayer }: {
      category: string; summary: string; detail: string; suggestion?: string
      suggestedLayer?: 'tenant' | 'repo'
    }) => {
      const job = await ctx.stateBackend.getJob(ctx.job.id) as Job
      const now = new Date()
      const rand = Math.random().toString(36).slice(2, 8)
      const insight: Insight = {
        id: `ins-${now.getTime()}-${rand}`,
        phase: job.phase,
        category,
        summary,
        detail,
        status: 'pending',
        ...(suggestion ? { suggestion } : {}),
        ...(suggestedLayer ? { suggestedLayer } : {}),
      }
      const insights = [...(job.insights ?? []), insight]
      await ctx.stateBackend.updateJob(ctx.job.id, { insights })
      ctx.job = await ctx.stateBackend.getJob(ctx.job.id) as Job
      await ctx.stateBackend.appendLog(ctx.job.id, `[insight] ${category}: ${summary}`)
      return text({ recorded: true, insightId: insight.id, totalInsights: insights.length })
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

    // Cross-job history (retrospective jobs only). Implementations live in
    // `tools/job-history.ts`; the type gate is enforced there so the same
    // rule applies however the tool is invoked.
    list_jobs: async (args: { limit?: number; status?: string; since?: string; scope?: 'job' | 'retrospective' }) => {
      const { listJobHistory } = await import('./tools/job-history')
      try {
        return text(await listJobHistory(args, ctx))
      } catch (err) {
        return error((err as Error).message)
      }
    },

    get_job_report: async (args: { jobId: string; raw?: boolean }) => {
      const { buildJobReportById } = await import('./tools/job-history')
      try {
        return text(await buildJobReportById(args, ctx))
      } catch (err) {
        return error((err as Error).message)
      }
    },

    get_job_log_excerpts: async (args: { jobId: string; pattern?: string; limit?: number; raw?: boolean }) => {
      const { getJobLogExcerpts } = await import('./tools/job-history')
      try {
        return text(await getJobLogExcerpts(args, ctx))
      } catch (err) {
        return error((err as Error).message)
      }
    },

    cluster_window: async (args: { limit?: number; since?: string }) => {
      const { clusterWindow } = await import('./tools/job-trace')
      try {
        return text(await clusterWindow(args, ctx))
      } catch (err) {
        return error((err as Error).message)
      }
    },

    get_job_trace_summary: async (args: { jobId: string; raw?: boolean }) => {
      const { getJobTraceSummary } = await import('./tools/job-trace')
      try {
        return text(await getJobTraceSummary(args, ctx))
      } catch (err) {
        return error((err as Error).message)
      }
    },

    // Upstream contribution (retrospective jobs only). Implementations live
    // in `tools/upstream.ts`, which owns the tier gate, the sanitisation
    // gate, and the per-run publication caps.
    upstream_checkout: async () => {
      const { upstreamCheckout } = await import('./tools/upstream')
      try {
        return text(await upstreamCheckout({}, ctx))
      } catch (err) {
        return error((err as Error).message)
      }
    },

    upstream_search: async (args: UpstreamSearchArgs) => {
      const { upstreamSearch } = await import('./tools/upstream')
      try {
        return text(await upstreamSearch(args, ctx))
      } catch (err) {
        return error((err as Error).message)
      }
    },

    upstream_create_issue: async (args: UpstreamCreateIssueArgs) => {
      const { upstreamCreateIssue } = await import('./tools/upstream')
      try {
        return text(await upstreamCreateIssue(args, ctx))
      } catch (err) {
        return error((err as Error).message)
      }
    },

    upstream_comment_issue: async (args: UpstreamCommentIssueArgs) => {
      const { upstreamCommentIssue } = await import('./tools/upstream')
      try {
        return text(await upstreamCommentIssue(args, ctx))
      } catch (err) {
        return error((err as Error).message)
      }
    },

    dispatch_improvement_job: async (args: DispatchImprovementJobArgs) => {
      const { dispatchImprovementJob } = await import('./tools/upstream')
      try {
        return text(await dispatchImprovementJob(args, ctx))
      } catch (err) {
        return error((err as Error).message)
      }
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
      deltas?: Array<{
        path: string
        heading?: string
        mode: 'insert-after' | 'replace-section' | 'append'
        content: string
      }>
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
      const jobDir = jobWorkingDir()
      const guardCtx = buildGuardrailContext({
        on: 'propose_change',
        toolName: 'mcp__coro__propose_change',
        toolInput: args as unknown as Record<string, unknown>,
        job: ctx.job,
        workingDir: jobDir,
      })
      const guardDecision = await guardrailEngine.evaluate('propose_change', guardCtx)
      if (!guardDecision.allow) {
        return mcpError(guardDecision.reason ?? 'Guardrail blocked propose_change.')
      }

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
      trackerEpicRef?: { pluginId: string; key: string; url: string }
    }) => {
      const { convertToCampaign } = await import('./tools/campaign')
      try {
        const result = await convertToCampaign(args, ctx, signals)
        return text(result)
      } catch (err) {
        return error((err as Error).message)
      }
    },

    // Generic in-place workflow lane change. Replaces the legacy
    // "switch via convert_to_campaign" trick for any non-campaign lane.
    // Implementation lives in `tools/workflow-switch.ts`.
    switch_workflow: async (args: {
      workflowPath: string
      paramsPatch?: Record<string, unknown>
      reason: string
      toPhase?: string
    }) => {
      const { switchWorkflow } = await import('./tools/workflow-switch')
      try {
        const result = await switchWorkflow(args, ctx, signals)
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
      trackerRef?: { pluginId: string; key: string; url: string }
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

async function isGitRepo(dir: string): Promise<boolean> {
  const stat = await fs.stat(path.join(dir, '.git')).catch(() => null)
  return stat?.isDirectory() ?? false
}

/** Interrupted `git clone` leaves `.git` plus an in-flight `tmp_pack_*`. */
async function cloneLooksIncomplete(repoDir: string): Promise<boolean> {
  const packDir = path.join(repoDir, '.git', 'objects', 'pack')
  const names = await fs.readdir(packDir).catch(() => [] as string[])
  return names.some(n => n.startsWith('tmp_pack'))
}

export type McpToolHandlers = ReturnType<typeof createMcpToolHandlers>

// ── Glob/walk helpers for file_glob / file_grep ──────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', '.coro', 'dist', 'build', '.next', '.cache'])

async function walkDir(
  start: string,
  rootForRel: string,
  visit: (relFromRoot: string, entry: import('fs').Dirent) => Promise<void>,
): Promise<void> {
  let entries: import('fs').Dirent[]
  try { entries = await fs.readdir(start, { withFileTypes: true }) }
  catch { return }
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
    const abs = path.join(start, entry.name)
    const rel = path.relative(rootForRel, abs)
    await visit(rel, entry)
    if (entry.isDirectory()) await walkDir(abs, rootForRel, visit)
  }
}

function globToRegex(pattern: string): RegExp {
  // Translate a minimal glob (`**`, `*`, `?`) into a regex anchored at both ends.
  // `**` matches any number of path segments (including none); `*` matches
  // anything except `/`; `?` matches a single non-`/` char.
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` → match zero+ segments incl. trailing slash
        if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 2 }
        else { re += '.*'; i += 1 }
      } else { re += '[^/]*' }
    } else if (c === '?') { re += '[^/]' }
    else if ('.+^$(){}|[]\\'.includes(c)) { re += '\\' + c }
    else { re += c }
  }
  return new RegExp('^' + re + '$')
}
