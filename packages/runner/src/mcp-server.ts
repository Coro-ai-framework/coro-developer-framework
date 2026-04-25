import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { ToolContext, PhaseSignals } from './tools/types'
import { createMcpToolHandlers } from './mcp-handlers'

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Build an in-process MCP server exposing all Coro domain tools.
 *
 * The SDK's built-in tools handle filesystem, shell, git, and code search.
 * This server provides everything else: BitBucket, observability, Jira,
 * test harness, job control, and self-improvement tools.
 *
 * The `ctx` and `signals` objects are shared references — the runner swaps
 * `ctx.job` between phases, and reads `signals` after each query() completes.
 *
 * Tool implementations live in {@link createMcpToolHandlers} for testability.
 *
 * The server name `coro` flows into the tool prefix the SDK exposes to agents
 * (`mcp__coro__*`). All agent markdown that references these tools must use
 * the `mcp__coro__` prefix.
 */
export function createCoroMcpServer(ctx: ToolContext, signals: PhaseSignals) {
  const h = createMcpToolHandlers(ctx, signals)

  return createSdkMcpServer({
    name: 'coro',
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
        'Open a pull request from the current work-item branch. Reviewers default to job reviewers if omitted.',
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

      // ── GitHub ────────────────────────────────────────────────────────────

      tool(
        'gh_create_repo',
        'Create a new private GitHub repository.',
        { repoSlug: z.string(), description: z.string().optional() },
        h.gh_create_repo,
      ),

      tool(
        'gh_create_pr',
        'Open a pull request on GitHub. Reviewers default to job reviewers if omitted.',
        {
          repoSlug: z.string(),
          title: z.string(),
          description: z.string().optional(),
          sourceBranch: z.string(),
          targetBranch: z.string().optional(),
          reviewerUsernames: z.array(z.string()).optional(),
        },
        h.gh_create_pr,
      ),

      tool(
        'gh_get_pr_status',
        'Get the current state and approval count of a GitHub pull request.',
        { repoSlug: z.string(), prId: z.number() },
        h.gh_get_pr_status,
        { annotations: { readOnlyHint: true } },
      ),

      tool(
        'gh_get_pr_comments',
        'List all comments on a GitHub pull request.',
        { repoSlug: z.string(), prId: z.number() },
        h.gh_get_pr_comments,
        { annotations: { readOnlyHint: true } },
      ),

      tool(
        'gh_post_pr_comment',
        'Post a new top-level comment on a GitHub pull request.',
        { repoSlug: z.string(), prId: z.number(), content: z.string() },
        h.gh_post_pr_comment,
      ),

      tool(
        'gh_reply_to_comment',
        'Reply to an existing review comment on a GitHub pull request.',
        { repoSlug: z.string(), prId: z.number(), parentId: z.number(), content: z.string() },
        h.gh_reply_to_comment,
      ),

      tool(
        'gh_approve_pr',
        'Approve a GitHub pull request.',
        { repoSlug: z.string(), prId: z.number() },
        h.gh_approve_pr,
      ),

      tool(
        'gh_merge_pr',
        'Merge a GitHub pull request (squash merge). Only call when approved.',
        { repoSlug: z.string(), prId: z.number(), message: z.string().optional() },
        h.gh_merge_pr,
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

      // ── Work-item tracking ───────────────────────────────────────────────

      tool(
        'set_work_items',
        'Register the ordered work-item list for this job. Called after producing the implementation plan.',
        { workItems: z.array(z.string()) },
        h.set_work_items,
      ),

      tool(
        'update_work_item',
        'Update a work item\'s status or increment its loop count. Called by evaluator/coder.',
        {
          name: z.string(),
          status: z.enum(['pending', 'in-progress', 'complete', 'escalated']).optional(),
          incrementLoop: z.boolean().optional(),
        },
        h.update_work_item,
      ),

      tool(
        'get_work_items',
        'Read the current work-item list with statuses and loop counts.',
        {},
        h.get_work_items,
        { annotations: { readOnlyHint: true } },
      ),

      tool(
        'request_new_session',
        'Clear the session ID so the next phase starts a fresh conversation. Call when switching to a new work item or when context is stale.',
        { reason: z.string() },
        h.request_new_session,
      ),

      tool(
        'set_job_params',
        'Merge key-value pairs into job.params. Use to set language, build commands, or other dynamic context for downstream phases.',
        { params: z.record(z.string(), z.unknown()) },
        h.set_job_params,
      ),

      // ── Job control ───────────────────────────────────────────────────────

      tool(
        'goto_phase',
        'Override which phase runs next (e.g. go back to "coding" after posting review comments). Ends the current turn.',
        { phase: z.string() },
        h.goto_phase,
      ),

      tool(
        'await_event',
        'Park the job and wait for an external event (e.g. PR merge, Jira comment). The runner stops until the webhook arrives. Only call this when you genuinely need to wait — otherwise just finish and the runner auto-advances. To pause mid-phase for developer input (interactive mode), pass eventName "developer-input: <short reason>"; the job will park with status `awaiting-developer-input` and resume when the developer replies.',
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
        'Append a log line to the job stream. Developers watch this via `coro logs --job <id>`. Call constantly.',
        { message: z.string() },
        h.log,
      ),

      // ── Artefacts ─────────────────────────────────────────────────────────

      tool(
        'post_artifact',
        'Record a per-phase artefact that the developer dashboard can display (e.g. a plan markdown file, a PR link, a test report). The `data` object is opaque to the runner — only the dashboard knows how to render each `kind`. Call this after you produce any output that a developer should see in the UI. Common kinds: plan-md, implementation-plan-md, pr-link, report-md, test-results, evaluation-md, analysis-contract, url.',
        {
          phase: z.string().optional().describe('Defaults to the current phase'),
          kind: z.string().describe('Render hint for the dashboard, e.g. plan-md | pr-link | url | report-md | test-results | json'),
          title: z.string().describe('Short human label shown on the phase node'),
          data: z.record(z.string(), z.unknown()).optional().describe('Arbitrary JSON, typically { path } or { url, ... }'),
        },
        h.post_artifact,
      ),

      tool(
        'get_artifacts',
        'Read back the artefacts posted for this job (optionally filtered by phase).',
        { phase: z.string().optional() },
        h.get_artifacts,
        { annotations: { readOnlyHint: true } },
      ),

      // ── Self-improvement ──────────────────────────────────────────────────

      tool(
        'add_insight',
        'Record a learning, workaround, or pattern discovery for the evaluator to review. Call this whenever you discover something through trial-and-error that future runs should know.',
        {
          category: z.string().describe('e.g. "auth", "tooling", "convention-gap", "api-quirk", "dependency"'),
          summary: z.string().describe('One-line summary of the insight'),
          detail: z.string().describe('Full context: what was tried, what worked, why'),
          suggestion: z.string().optional().describe('Optional: what should be updated (memory, convention, agent instructions)'),
        },
        h.add_insight,
      ),

      tool(
        'propose_change',
        'Propose an improvement to the Agent Host. Supports multi-file proposals. The watcher validates and opens a PR.',
        {
          type: z.enum([
            'new-tool', 'modify-tool', 'new-workflow', 'modify-workflow',
            'new-agent', 'modify-agent', 'memory-update', 'source-change',
            'skill-create', 'skill-update', 'claude-md-update',
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

      // ── On-demand context ─────────────────────────────────────────────────

      tool(
        'read_memory',
        'Load accumulated memory (known pitfalls, patterns, conventions) plus any pending self-improvement proposals. No args: returns the memory index + every linked file + pending proposals. Pass `file` (relative to memory/) to fetch a single file. Call this when you start a job OR when you need to check prior learnings before making decisions — the system prompt no longer carries memory by default.',
        { file: z.string().optional().describe('Optional path relative to memory/, e.g. "known-pitfalls.md"') },
        h.read_memory,
        { annotations: { readOnlyHint: true } },
      ),

    ],
  })
}
