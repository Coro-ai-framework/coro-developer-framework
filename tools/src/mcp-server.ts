import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { ToolContext, PhaseSignals } from './tools/types'

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Build an in-process MCP server exposing all A5 domain tools.
 *
 * The SDK's built-in tools handle filesystem, shell, git, and code search.
 * This server provides everything else: BitBucket, observability, Jira,
 * test harness, job control, and self-improvement tools.
 *
 * The `ctx` and `signals` objects are shared references — the runner swaps
 * `ctx.job` between phases, and reads `signals` after each query() completes.
 */
export function createA5McpServer(ctx: ToolContext, signals: PhaseSignals) {

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function text(data: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
  }

  function error(msg: string) {
    return { content: [{ type: 'text' as const, text: msg }], isError: true as const }
  }

  // ── Tool definitions ────────────────────────────────────────────────────────

  return createSdkMcpServer({
    name: 'a5',
    tools: [

      // ── BitBucket — coder account ─────────────────────────────────────────

      tool(
        'bb_create_repo',
        'Create a new private BitBucket repository.',
        { repoSlug: z.string(), description: z.string().optional() },
        async ({ repoSlug, description }) => {
          const repo = await ctx.bbCoder.createRepo({ repoSlug, description, isPrivate: true })
          return text({ fullName: repo.full_name })
        },
      ),

      tool(
        'bb_create_pr',
        'Open a pull request from a feature branch. Reviewers default to job reviewers if omitted.',
        {
          repoSlug: z.string(),
          title: z.string(),
          description: z.string().optional(),
          sourceBranch: z.string(),
          targetBranch: z.string().optional(),
          reviewerUsernames: z.array(z.string()).optional(),
        },
        async ({ repoSlug, title, description, sourceBranch, targetBranch, reviewerUsernames }) => {
          const { jobReviewers } = await import('./jobs/types')
          const pr = await ctx.bbCoder.createPr({
            repoSlug, title, description,
            sourceBranch,
            targetBranch: targetBranch ?? 'main',
            reviewerUsernames: reviewerUsernames ?? jobReviewers(ctx.job),
          })
          return text({ prId: pr.id, url: pr.links.html.href, state: pr.state })
        },
      ),

      tool(
        'bb_get_pr_status',
        'Get the current state and approval count of a pull request.',
        { repoSlug: z.string(), prId: z.number() },
        async ({ repoSlug, prId }) => {
          const status = await ctx.bbCoder.getPrStatus(repoSlug, prId)
          return text(status)
        },
        { annotations: { readOnlyHint: true } },
      ),

      // ── BitBucket — reviewer account ──────────────────────────────────────

      tool(
        'bb_get_pr_comments',
        'List all comments on a pull request.',
        { repoSlug: z.string(), prId: z.number() },
        async ({ repoSlug, prId }) => {
          const comments = await ctx.bbReviewer.getComments(repoSlug, prId)
          const mapped = comments.map(c => ({
            id: c.id,
            content: c.content.raw,
            parentId: c.parent?.id ?? null,
            createdOn: c.created_on,
            inline: c.inline ?? null,
          }))
          return text(mapped)
        },
        { annotations: { readOnlyHint: true } },
      ),

      tool(
        'bb_post_pr_comment',
        'Post a new top-level comment on a pull request (reviewer account).',
        { repoSlug: z.string(), prId: z.number(), content: z.string() },
        async ({ repoSlug, prId, content }) => {
          const comment = await ctx.bbReviewer.postComment(repoSlug, prId, content)
          return text({ commentId: comment.id })
        },
      ),

      tool(
        'bb_reply_to_comment',
        'Reply to an existing comment thread on a pull request (reviewer account).',
        { repoSlug: z.string(), prId: z.number(), parentId: z.number(), content: z.string() },
        async ({ repoSlug, prId, parentId, content }) => {
          const comment = await ctx.bbReviewer.replyToComment(repoSlug, prId, parentId, content)
          return text({ commentId: comment.id })
        },
      ),

      tool(
        'bb_approve_pr',
        'Approve a pull request using the reviewer account.',
        { repoSlug: z.string(), prId: z.number() },
        async ({ repoSlug, prId }) => {
          await ctx.bbReviewer.approvePr(repoSlug, prId)
          return text({ approved: true })
        },
      ),

      tool(
        'bb_merge_pr',
        'Merge a pull request. Only call when approved and all comments are resolved.',
        { repoSlug: z.string(), prId: z.number(), message: z.string().optional() },
        async ({ repoSlug, prId, message }) => {
          const pr = await ctx.bbReviewer.mergePr(repoSlug, prId, message)
          return text({ state: pr.state })
        },
      ),

      // ── Test harness ──────────────────────────────────────────────────────

      tool(
        'run_go_build',
        'Compile the Go project in a directory. Returns stdout/stderr.',
        { repoDir: z.string() },
        async ({ repoDir }) => {
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
      ),

      tool(
        'start_go_service',
        'Start a compiled Go binary in the background on a given port.',
        {
          label: z.string(),
          repoDir: z.string(),
          binaryName: z.string(),
          port: z.number(),
          env: z.record(z.string(), z.string()).optional(),
        },
        async ({ label, repoDir, binaryName, port, env: extraEnv }) => {
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
      ),

      tool(
        'stop_go_service',
        'Stop a running Go service by its label.',
        { label: z.string() },
        async ({ label }) => {
          const child = ctx.runningServices.get(label)
          if (!child) return error(`No running service with label "${label}"`)
          child.kill('SIGTERM')
          ctx.runningServices.delete(label)
          return text({ stopped: label })
        },
      ),

      tool(
        'compare_request',
        'Send the same HTTP request to both Go and .NET services, then diff responses.',
        {
          goBaseUrl: z.string(),
          dotnetBaseUrl: z.string(),
          method: z.string(),
          path: z.string(),
          headers: z.record(z.string(), z.string()).optional(),
          body: z.string().optional(),
        },
        async ({ goBaseUrl, dotnetBaseUrl, method, path: reqPath, headers, body }) => {
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
        { annotations: { readOnlyHint: true } },
      ),

      // ── Observability ─────────────────────────────────────────────────────

      tool(
        'loki_query',
        'Run a LogQL query against Loki. Returns log lines matching the query.',
        { logQL: z.string(), start: z.string(), end: z.string().optional(), limit: z.number().optional() },
        async ({ logQL, start, end, limit }) => {
          const result = await ctx.lokiClient.query(logQL, start, end ?? 'now', limit ?? 500)
          return text(result)
        },
        { annotations: { readOnlyHint: true } },
      ),

      tool(
        'tempo_get_trace',
        'Fetch a full distributed trace by trace ID from Tempo.',
        { traceId: z.string() },
        async ({ traceId }) => {
          const result = await ctx.tempoClient.getTrace(traceId)
          return text(result)
        },
        { annotations: { readOnlyHint: true } },
      ),

      tool(
        'tempo_search',
        'Search for traces matching a TraceQL query.',
        { query: z.string(), start: z.string(), end: z.string().optional(), limit: z.number().optional() },
        async ({ query: q, start, end, limit }) => {
          const result = await ctx.tempoClient.search(q, start, end, limit ?? 20)
          return text(result)
        },
        { annotations: { readOnlyHint: true } },
      ),

      // ── Jira ──────────────────────────────────────────────────────────────

      tool(
        'jira_get_issue',
        'Fetch a Jira issue by ticket ID. Returns fields, status, and transitions.',
        { ticketId: z.string() },
        async ({ ticketId }) => {
          const result = await ctx.jiraClient.getIssue(ticketId)
          return text(result)
        },
        { annotations: { readOnlyHint: true } },
      ),

      tool(
        'jira_post_comment',
        'Post a comment on a Jira issue.',
        { ticketId: z.string(), body: z.string() },
        async ({ ticketId, body }) => {
          const result = await ctx.jiraClient.postComment(ticketId, body)
          return text(result)
        },
      ),

      tool(
        'jira_transition_issue',
        'Move a Jira issue to a new status.',
        { ticketId: z.string(), transitionId: z.string() },
        async ({ ticketId, transitionId }) => {
          const result = await ctx.jiraClient.transitionIssue(ticketId, transitionId)
          return text(result ?? { transitioned: true })
        },
      ),

      // ── Job control ───────────────────────────────────────────────────────

      tool(
        'mark_phase_complete',
        'Signal that the current phase is done. The runner will advance to the next phase or complete the job.',
        {},
        async () => {
          signals.phaseComplete = true
          return text({ phaseComplete: true })
        },
      ),

      tool(
        'await_event',
        'Park the job and wait for an external event (e.g. PR merge, comment). The runner stops until the webhook arrives.',
        { eventName: z.string(), prId: z.number().optional() },
        async ({ eventName, prId }) => {
          signals.awaitingEvent = eventName
          signals.awaitingPrId = prId
          return text({ awaiting: eventName, prId: prId ?? null })
        },
      ),

      tool(
        'escalate',
        'Escalate the job to a human. Sets the job status to Escalated and stops the runner.',
        { reason: z.string() },
        async ({ reason }) => {
          const { STATUS_ESCALATED } = await import('./jobs/types')
          await ctx.registry.updateJob(ctx.job.id, {
            status: STATUS_ESCALATED,
            escalationMessage: reason,
          })
          signals.escalated = true
          signals.escalationReason = reason
          ctx.logger.warn({ jobId: ctx.job.id, reason }, 'Job escalated')
          return text({ escalated: true, reason })
        },
      ),

      tool(
        'log',
        'Append a log line to the job stream. Developers watch this via `a5 logs --job <id>`. Call constantly.',
        { message: z.string() },
        async ({ message }) => {
          await ctx.registry.appendLog(ctx.job.id, message)
          return text(null)
        },
      ),

      // ── Self-improvement ──────────────────────────────────────────────────

      tool(
        'propose_change',
        'Propose an improvement to the Agent Host. Supports multi-file proposals. The watcher validates and opens a PR.',
        {
          type: z.enum([
            'new-tool', 'modify-tool', 'new-workflow', 'modify-workflow',
            'new-agent', 'modify-agent', 'convention-change', 'memory-update', 'source-change',
          ]),
          title: z.string(),
          rationale: z.string(),
          description: z.string(),
          files: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
          targetFile: z.string().optional(),
          proposedContent: z.string().optional(),
        },
        async (args) => {
          const { proposeChange } = await import('./tools/self-improvement')
          const result = await proposeChange({
            type: args.type,
            title: args.title,
            rationale: args.rationale,
            description: args.description,
            files: args.files as Array<{ path: string; content: string }> | undefined,
            targetFile: args.targetFile,
            proposedContent: args.proposedContent,
          }, ctx)
          return text(result)
        },
      ),

      tool(
        'list_proposals',
        'List past proposals filed by agents. Check before proposing duplicates.',
        { limit: z.number().optional(), type: z.string().optional() },
        async (args) => {
          const { listProposals } = await import('./tools/self-improvement')
          const result = await listProposals({ limit: args.limit, type: args.type }, ctx)
          return text(result)
        },
        { annotations: { readOnlyHint: true } },
      ),

    ],
  })
}
