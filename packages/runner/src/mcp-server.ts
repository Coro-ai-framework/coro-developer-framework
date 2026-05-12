import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { ToolContext, PhaseSignals } from './tools/types'
import { createMcpToolHandlers, mcpError, mcpText } from './mcp-handlers'

// Legacy `bb_*` / `gh_*` / `jira_*` tools were removed entirely in
// S6 of the MCP-first plugins pivot. Workflow markdown that still
// names a legacy tool now hits the SDK's "tool not found" path; the
// agent sees a clean error and is expected to call the trimmed
// `scm_*` / `tracker_*` surface or the upstream MCP server directly
// (`mcp__github__*`, `mcp__jira__*`, …).

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

  // Plugin extension tools — provider-specific tools that don't fit
  // the generic `scm_*` / `tracker_*` surface (e.g. `gh_create_release`,
  // `bb_pipeline_run`). The registry refuses collisions so two
  // plugins can never silently overwrite the same name.
  const extensionTools = ctx.plugins.collectExtensionTools().map(def =>
    tool(
      def.name,
      def.description,
      def.inputSchema,
      async (args: Record<string, unknown>) => {
        try {
          const result = await def.handler(args)
          return mcpText(result)
        } catch (err) {
          return mcpError((err as Error).message)
        }
      },
      def.annotations ? { annotations: def.annotations } : {},
    ),
  )

  return createSdkMcpServer({
    name: 'coro',
    tools: [
      ...extensionTools,

      // ── Generic SCM (MCP-first proxy) ─────────────────────────────────────
      //
      // After the MCP-first plugins pivot, only seven high-traffic ops
      // survive as a provider-neutral shim: open PR, read PR status,
      // list / post PR comments, merge PR, resolve clone info, and
      // clone the target repo into the job sandbox.
      // Everything else (repo creation, approvals, threaded replies,
      // change-detection polls) is now expected to come from the
      // upstream MCP server attached by the active SCM plugin — the
      // agent calls `mcp__<pluginId>__<tool>` directly.
      //
      // For native-mode plugins (BitBucket today) these wrappers hit
      // the plugin's native methods. For MCP-mode plugins (GitHub) the
      // wrapper returns a structured redirect telling the agent which
      // upstream tool to call, costing one extra round-trip. We accept
      // that cost in exchange for a tiny, stable, provider-agnostic
      // tool surface that workflow markdown can rely on.

      tool(
        'scm_create_pr',
        'Open a pull request via the configured SCM plugin. Reviewers default to job reviewers when omitted.',
        {
          pluginId: z.string().optional(),
          repo: z.string(),
          title: z.string(),
          description: z.string().optional(),
          sourceBranch: z.string(),
          targetBranch: z.string().optional(),
          reviewers: z.array(z.string()).optional(),
        },
        h.scm_create_pr,
      ),

      tool(
        'scm_get_pr_status',
        'Get the current state and approval count of a pull request via the configured SCM plugin.',
        {
          pluginId: z.string().optional(),
          repo: z.string(),
          prId: z.union([z.number(), z.string()]),
        },
        h.scm_get_pr_status,
        { annotations: { readOnlyHint: true } },
      ),

      tool(
        'scm_list_pr_comments',
        'List all comments on a pull request via the configured SCM plugin.',
        {
          pluginId: z.string().optional(),
          repo: z.string(),
          prId: z.union([z.number(), z.string()]),
        },
        h.scm_list_pr_comments,
        { annotations: { readOnlyHint: true } },
      ),

      tool(
        'scm_post_pr_comment',
        'Post a top-level comment on a pull request via the configured SCM plugin.',
        {
          pluginId: z.string().optional(),
          repo: z.string(),
          prId: z.union([z.number(), z.string()]),
          body: z.string(),
        },
        h.scm_post_pr_comment,
      ),

      tool(
        'scm_merge_pr',
        'Merge a pull request via the configured SCM plugin. Only call when approved and conversations are resolved.',
        {
          pluginId: z.string().optional(),
          repo: z.string(),
          prId: z.union([z.number(), z.string()]),
          message: z.string().optional(),
          strategy: z.enum(['merge', 'squash', 'rebase']).optional(),
        },
        h.scm_merge_pr,
      ),

      tool(
        'scm_get_clone_info',
        'Get the clone URL and git env for a repo via the configured SCM plugin. Prefer scm_clone_repo for the standard checkout path.',
        {
          pluginId: z.string().optional(),
          repo: z.string(),
        },
        h.scm_get_clone_info,
        { annotations: { readOnlyHint: true } },
      ),

      tool(
        'scm_clone_repo',
        'Clone a repo into the current job working directory via the configured SCM plugin. Prefer this over running git clone in Bash.',
        {
          pluginId: z.string().optional(),
          repo: z.string(),
        },
        h.scm_clone_repo,
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

      // ── Tracker (provider-agnostic, MCP-first proxy) ─────────────────────
      //
      // After the MCP-first plugins pivot, only the three high-traffic
      // ops survive as a generic shim. Everything else (epic creation,
      // child listings, links) is now expected to flow through the
      // upstream MCP server attached by the active tracker plugin —
      // agents call `mcp__<pluginId>__<tool>` directly. These three
      // remain because they show up in nearly every workflow and we
      // want one canonical name regardless of the tracker.
      //
      // For native-mode plugins (none today: Jira/Linear/GH-Issues are
      // MCP-mode, but BitBucket-style natives are still allowed) the
      // proxy hits the plugin's native `getIssue/commentIssue/
      // transitionIssue`. For MCP-mode plugins it returns a structured
      // redirect telling the agent which `mcp__<pluginId>__<tool>` to
      // call instead, costing one extra round-trip. The redirect is
      // cheap and keeps the agent's tool surface small.

      tool(
        'tracker_get_issue',
        'Fetch a single tracker issue by its key via the configured tracker plugin.',
        {
          pluginId: z.string().optional(),
          key: z.string(),
        },
        h.tracker_get_issue,
        { annotations: { readOnlyHint: true } },
      ),

      tool(
        'tracker_transition_issue',
        'Move a tracker issue to a target status by name (e.g. "In Progress", "Done").',
        {
          pluginId: z.string().optional(),
          key: z.string(),
          status: z.string(),
        },
        h.tracker_transition_issue,
      ),

      tool(
        'tracker_comment_issue',
        'Post a plain-text comment on a tracker issue via the configured tracker plugin.',
        {
          pluginId: z.string().optional(),
          key: z.string(),
          body: z.string(),
        },
        h.tracker_comment_issue,
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
        'Ship a self-improvement as a PR against the tenant intelligence repo or the project repo\'s .coro/ overlay. ONE call per (job, layer) — the runner rejects a second call. Prefer the `entries` field for memory updates: it serialises into the canonical short-form layout and enforces hard line budgets (pitfall ≤ 8 lines, pattern ≤ 10 lines).',
        {
          type: z.enum([
            'new-tool', 'modify-tool', 'new-workflow', 'modify-workflow',
            'new-agent', 'modify-agent', 'memory-update',
            'skill-create', 'skill-update', 'claude-md-update',
          ]),
          title: z.string().describe('Short, human-readable title; becomes the PR title.'),
          rationale: z.string().describe('Why this change is worth merging — drives the PR description and future list_proposals previews. Two sentences max.'),
          description: z.string().describe('Implementation details / what the diff does. Be terse.'),
          files: z.array(z.object({ path: z.string(), content: z.string() })).optional()
            .describe('Multi-file payload. Paths are relative to the target layer\'s root.'),
          entries: z.array(z.object({
            file: z.string().describe('Memory file the entry lands in (memory/* or .coro/memory/*).'),
            kind: z.enum(['pitfall', 'pattern']),
            title: z.string().describe('One-line ## heading.'),
            symptom: z.string().optional().describe('Pitfall: one-line symptom.'),
            rootCause: z.string().optional().describe('Pitfall: one-line root cause.'),
            recipe: z.string().optional().describe('Copy-paste recipe (pitfall) or code skeleton (pattern). Multi-line allowed within the budget.'),
            antiPattern: z.string().optional().describe('Pattern: one-line anti-pattern note.'),
            whenToUse: z.string().optional().describe('Pattern: one-line "when to use" note.'),
          })).optional()
            .describe('Structured memory entries. Preferred over hand-composed markdown for memory-update proposals — saves prompt tokens and enforces brevity caps.'),
          targetFile: z.string().optional().describe('Single-file shim. Use `files` for multi-file proposals.'),
          proposedContent: z.string().optional(),
          targetLayer: z.enum(['tenant', 'repo']).optional()
            .describe('Where the change lands. Optional under default path-based routing (.coro/* → repo, else → tenant); required when proposals.routing.strategy=agent.'),
        },
        h.propose_change,
      ),

      tool(
        'list_proposals',
        'List past proposals for this tenant from the state backend (de-dup before proposing). Filter by `status` (pending/approved/rejected) or `type`.',
        {
          limit: z.number().optional(),
          type: z.string().optional(),
          status: z.enum(['pending', 'approved', 'rejected']).optional(),
        },
        h.list_proposals,
        { annotations: { readOnlyHint: true } },
      ),

      // ── Campaign coordination ─────────────────────────────────────────────

      tool(
        'convert_to_campaign',
        'Promote the active job into a campaign. Call this from the planning phase ONLY when the work is too large for a single job (multiple services, > ~5 PRs, clear dependency layers). Switches the job\'s workflow to the campaign workflow and resets phase to campaign-planning. Refused if params.epicAllowed=false (children of an existing campaign cannot recurse).',
        {
          title: z.string().describe('Short epic title — surfaces on the tracker epic and PR copy.'),
          description: z.string().describe('Long-form feature description handed to the campaign-planner agent.'),
          trackerEpicRef: z.object({
            provider: z.enum(['jira', 'github', 'linear']),
            key: z.string(),
            url: z.string(),
          }).optional().describe('Optional pointer to a pre-existing tracker epic; otherwise the campaign-planner creates one.'),
        },
        h.convert_to_campaign,
      ),

      tool(
        'switch_workflow',
        'Switch the active job to a different workflow lane in place. Use when the planner / evaluator detects the current lane is mis-sized (e.g. promote a tiny task to job-fast, or escalate to job-deep). Path-based admission: target workflow must exist in any layer (base, tenant, repo). Refused if target equals the campaign workflow and params.epicAllowed=false.',
        {
          workflowPath: z.string().describe('Workflow markdown path relative to the intelligence root (e.g. "workflows/job-fast/workflow.md").'),
          paramsPatch: z.record(z.string(), z.unknown()).optional().describe('Shallow merge into job.params (e.g. seed lane-specific options). Other fields are preserved.'),
          reason: z.string().describe('Short audit message — surfaces in the run log and in workflowPathHistory.'),
          toPhase: z.string().optional().describe('Optional explicit start phase on the new workflow. Must be declared by it; otherwise the workflow\'s initial_phase is used.'),
        },
        h.switch_workflow,
      ),

      tool(
        'campaign_register_child',
        'Register a single child issue spec on a campaign. Call once per issue from the campaign-planner. The dispatcher dispatches each child as a normal job when its dependsOn list is satisfied.',
        {
          name: z.string().describe('Slug-like unique name within this campaign (used as dependsOn key and branch suffix).'),
          description: z.string().describe('Scoped description for the child job (what the child planner sees).'),
          params: z.record(z.string(), z.unknown()).optional().describe('Seed params for the child job (e.g. repoSlug). The dispatcher injects epicAllowed=false and campaignParentId automatically.'),
          dependsOn: z.array(z.string()).optional().describe('Names of other registered children this one is blocked on.'),
          trackerRef: z.object({
            provider: z.enum(['jira', 'github', 'linear']),
            key: z.string(),
            url: z.string(),
          }).optional().describe('Tracker issue created for this child (typically created via tracker_create_issue first).'),
        },
        h.campaign_register_child,
      ),

      tool(
        'campaign_finalize',
        'Commit the campaign breakdown. Validates that every dependsOn references a registered child and that there are no cycles. Promotes children with no dependencies to "ready" and advances the campaign job to the coordinating phase. Call exactly once after registering all children.',
        {},
        h.campaign_finalize,
      ),

      tool(
        'campaign_status',
        'Read the current state of a campaign: per-child status, dependency graph, dispatch progress. Used by the campaign-evaluator and the dashboard.',
        {},
        h.campaign_status,
        { annotations: { readOnlyHint: true } },
      ),

      tool(
        'campaign_skip_child',
        'Mark a campaign child as skipped. Children blocked only on the skipped child become eligible for dispatch. Refused if the child has already reached a terminal status.',
        { name: z.string(), reason: z.string().optional() },
        h.campaign_skip_child,
      ),

      tool(
        'campaign_rerun_child',
        'Reset a terminal campaign child back to pending so the coordinator dispatches a fresh child job. Use after fixing the underlying issue (e.g. a flaky failure or a now-corrected spec). Only allowed when the child is in a terminal status.',
        { name: z.string(), reason: z.string().optional() },
        h.campaign_rerun_child,
      ),

      tool(
        'campaign_cancel_child',
        'Cancel/descope a campaign child. Allowed from any status except complete, skipped, or already cancelled — including failed and escalated children whose work has been abandoned (e.g. supplanted by a re-plan). Marks the child cancelled (terminal, treated as satisfied for dependency resolution — downstream proceeds and the parent does NOT halt). If the child has been dispatched and is still running, the underlying child Job is cancelled too.',
        { name: z.string(), reason: z.string().optional() },
        h.campaign_cancel_child,
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
