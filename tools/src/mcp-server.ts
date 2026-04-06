import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { ToolContext, PhaseSignals } from './tools/types'
import { createMcpToolHandlers } from './mcp-handlers'

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
 *
 * Tool implementations live in {@link createMcpToolHandlers} for testability.
 */
export function createA5McpServer(ctx: ToolContext, signals: PhaseSignals) {
  const h = createMcpToolHandlers(ctx, signals)

  return createSdkMcpServer({
    name: 'a5',
    tools: [

      // ── BitBucket — coder account ─────────────────────────────────────────

      tool(
        'bb_create_repo',
        'Create a new private BitBucket repository.',
        { repoSlug: z.string(), description: z.string().optional() },
        h.bb_create_repo,
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
        h.bb_create_pr,
      ),

      tool(
        'bb_get_pr_status',
        'Get the current state and approval count of a pull request.',
        { repoSlug: z.string(), prId: z.number() },
        h.bb_get_pr_status,
        { annotations: { readOnlyHint: true } },
      ),

      // ── BitBucket — reviewer account ──────────────────────────────────────

      tool(
        'bb_get_pr_comments',
        'List all comments on a pull request.',
        { repoSlug: z.string(), prId: z.number() },
        h.bb_get_pr_comments,
        { annotations: { readOnlyHint: true } },
      ),

      tool(
        'bb_post_pr_comment',
        'Post a new top-level comment on a pull request (reviewer account).',
        { repoSlug: z.string(), prId: z.number(), content: z.string() },
        h.bb_post_pr_comment,
      ),

      tool(
        'bb_reply_to_comment',
        'Reply to an existing comment thread on a pull request (reviewer account).',
        { repoSlug: z.string(), prId: z.number(), parentId: z.number(), content: z.string() },
        h.bb_reply_to_comment,
      ),

      tool(
        'bb_approve_pr',
        'Approve a pull request using the reviewer account.',
        { repoSlug: z.string(), prId: z.number() },
        h.bb_approve_pr,
      ),

      tool(
        'bb_merge_pr',
        'Merge a pull request. Only call when approved and all comments are resolved.',
        { repoSlug: z.string(), prId: z.number(), message: z.string().optional() },
        h.bb_merge_pr,
      ),

      // ── Test harness ──────────────────────────────────────────────────────

      tool(
        'run_go_build',
        'Compile the Go project in a directory. Returns stdout/stderr.',
        { repoDir: z.string() },
        h.run_go_build,
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
        h.start_go_service,
      ),

      tool(
        'stop_go_service',
        'Stop a running Go service by its label.',
        { label: z.string() },
        h.stop_go_service,
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
        h.compare_request,
        { annotations: { readOnlyHint: true } },
      ),

      // ── Observability ─────────────────────────────────────────────────────

      tool(
        'loki_query',
        'Run a LogQL query against Loki. Returns log lines matching the query.',
        { logQL: z.string(), start: z.string(), end: z.string().optional(), limit: z.number().optional() },
        h.loki_query,
        { annotations: { readOnlyHint: true } },
      ),

      tool(
        'tempo_get_trace',
        'Fetch a full distributed trace by trace ID from Tempo.',
        { traceId: z.string() },
        h.tempo_get_trace,
        { annotations: { readOnlyHint: true } },
      ),

      tool(
        'tempo_search',
        'Search for traces matching a TraceQL query.',
        { query: z.string(), start: z.string(), end: z.string().optional(), limit: z.number().optional() },
        h.tempo_search,
        { annotations: { readOnlyHint: true } },
      ),

      // ── Jira ──────────────────────────────────────────────────────────────

      tool(
        'jira_get_issue',
        'Fetch a Jira issue by ticket ID. Returns fields, status, and transitions.',
        { ticketId: z.string() },
        h.jira_get_issue,
        { annotations: { readOnlyHint: true } },
      ),

      tool(
        'jira_post_comment',
        'Post a comment on a Jira issue.',
        { ticketId: z.string(), body: z.string() },
        h.jira_post_comment,
      ),

      tool(
        'jira_transition_issue',
        'Move a Jira issue to a new status.',
        { ticketId: z.string(), transitionId: z.string() },
        h.jira_transition_issue,
      ),

      // ── Job control ───────────────────────────────────────────────────────

      tool(
        'mark_phase_complete',
        'Optional hint that you are done. The runner auto-advances to the next phase when you finish regardless, so this is not required. Calling it ends the current turn early.',
        {},
        h.mark_phase_complete,
      ),

      tool(
        'goto_phase',
        'Override which phase runs next (e.g. go back to "coding" after posting review comments). Ends the current turn.',
        { phase: z.string() },
        h.goto_phase,
      ),

      tool(
        'await_event',
        'Park the job and wait for an external event (e.g. PR merge, Jira comment). The runner stops until the webhook arrives. Only call this when you genuinely need to wait — otherwise just finish and the runner auto-advances.',
        { eventName: z.string(), prId: z.number().optional() },
        h.await_event,
      ),

      tool(
        'escalate',
        'Escalate the job to a human. Sets the job status to Escalated and stops the runner.',
        { reason: z.string() },
        h.escalate,
      ),

      tool(
        'log',
        'Append a log line to the job stream. Developers watch this via `a5 logs --job <id>`. Call constantly.',
        { message: z.string() },
        h.log,
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
        h.propose_change,
      ),

      tool(
        'list_proposals',
        'List past proposals filed by agents. Check before proposing duplicates.',
        { limit: z.number().optional(), type: z.string().optional() },
        h.list_proposals,
        { annotations: { readOnlyHint: true } },
      ),

    ],
  })
}
