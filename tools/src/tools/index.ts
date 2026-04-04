import { ToolContext, ToolResult } from './types'
import { readFile, writeFile, listDirectory, createDirectory } from './filesystem'
import { gitClone, gitCheckoutBranch, gitCommit, gitPush, gitDiff, gitStatus } from './git-tools'
import {
  bbCreateRepo, bbCreatePr, bbGetPrStatus,
  bbGetPrComments, bbPostPrComment, bbReplyToComment, bbApprovePr, bbMergePr,
} from './bitbucket-tools'
import { runGoBuild, startGoService, stopGoService, compareRequest } from './test-harness'
import { lokiQuery, tempoGetTrace, tempoSearch } from './observability-tools'
import { jiraGetIssue, jiraPostComment, jiraTransitionIssue } from './jira-tools'
import { markPhaseComplete, awaitEvent, escalate, log, proposeChange } from './job-control'

export type { ToolContext, ToolResult }

// ── Dispatch table ────────────────────────────────────────────────────────────
//
// Maps every tool name Claude may call to its implementation.
// Adding a new tool: implement it in the appropriate file, import it here,
// add an entry to this map, and add its definition to src/prompt/tools.ts.
// Nothing else changes.

type ToolHandler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>

const TOOLS: Record<string, ToolHandler> = {
  // Filesystem (4)
  read_file:        (i, c) => readFile(i as Parameters<typeof readFile>[0], c),
  write_file:       (i, c) => writeFile(i as Parameters<typeof writeFile>[0], c),
  list_directory:   (i, c) => listDirectory(i as Parameters<typeof listDirectory>[0], c),
  create_directory: (i, c) => createDirectory(i as Parameters<typeof createDirectory>[0], c),

  // Git (6)
  git_clone:           (i, c) => gitClone(i as Parameters<typeof gitClone>[0], c),
  git_checkout_branch: (i, c) => gitCheckoutBranch(i as Parameters<typeof gitCheckoutBranch>[0], c),
  git_commit:          (i, c) => gitCommit(i as Parameters<typeof gitCommit>[0], c),
  git_push:            (i, c) => gitPush(i as Parameters<typeof gitPush>[0], c),
  git_diff:            (i, c) => gitDiff(i as Parameters<typeof gitDiff>[0], c),
  git_status:          (i, c) => gitStatus(i as Parameters<typeof gitStatus>[0], c),

  // BitBucket — coder account (3)
  bb_create_repo:   (i, c) => bbCreateRepo(i as Parameters<typeof bbCreateRepo>[0], c),
  bb_create_pr:     (i, c) => bbCreatePr(i as Parameters<typeof bbCreatePr>[0], c),
  bb_get_pr_status: (i, c) => bbGetPrStatus(i as Parameters<typeof bbGetPrStatus>[0], c),

  // BitBucket — reviewer account (5)
  bb_get_pr_comments:  (i, c) => bbGetPrComments(i as Parameters<typeof bbGetPrComments>[0], c),
  bb_post_pr_comment:  (i, c) => bbPostPrComment(i as Parameters<typeof bbPostPrComment>[0], c),
  bb_reply_to_comment: (i, c) => bbReplyToComment(i as Parameters<typeof bbReplyToComment>[0], c),
  bb_approve_pr:       (i, c) => bbApprovePr(i as Parameters<typeof bbApprovePr>[0], c),
  bb_merge_pr:         (i, c) => bbMergePr(i as Parameters<typeof bbMergePr>[0], c),

  // Test harness (4)
  run_go_build:    (i, c) => runGoBuild(i as Parameters<typeof runGoBuild>[0], c),
  start_go_service: (i, c) => startGoService(i as Parameters<typeof startGoService>[0], c),
  stop_go_service:  (i, c) => stopGoService(i as Parameters<typeof stopGoService>[0], c),
  compare_request:  (i, c) => compareRequest(i as Parameters<typeof compareRequest>[0], c),

  // Observability (3)
  loki_query:       (i, c) => lokiQuery(i as Parameters<typeof lokiQuery>[0], c),
  tempo_get_trace:  (i, c) => tempoGetTrace(i as Parameters<typeof tempoGetTrace>[0], c),
  tempo_search:     (i, c) => tempoSearch(i as Parameters<typeof tempoSearch>[0], c),

  // Jira — stubbed, returns { available: false } until configured (3)
  jira_get_issue:       (i, c) => jiraGetIssue(i as Parameters<typeof jiraGetIssue>[0], c),
  jira_post_comment:    (i, c) => jiraPostComment(i as Parameters<typeof jiraPostComment>[0], c),
  jira_transition_issue: (i, c) => jiraTransitionIssue(i as Parameters<typeof jiraTransitionIssue>[0], c),

  // Job control (5)
  mark_phase_complete: (i, c) => markPhaseComplete(i as Parameters<typeof markPhaseComplete>[0], c),
  await_event:         (i, c) => awaitEvent(i as Parameters<typeof awaitEvent>[0], c),
  escalate:            (i, c) => escalate(i as Parameters<typeof escalate>[0], c),
  log:                 (i, c) => log(i as Parameters<typeof log>[0], c),
  propose_change:      (i, c) => proposeChange(i as Parameters<typeof proposeChange>[0], c),
}

export const TOOL_NAMES = Object.keys(TOOLS) as (keyof typeof TOOLS)[]

// ── Router ────────────────────────────────────────────────────────────────────

/**
 * Execute a tool by name with the input Claude provided.
 *
 * Called by the runner for every `tool_use` block in Claude's response.
 * Never throws — all errors are returned as { success: false, error: "..." }
 * so the runner can feed them back to Claude as tool_result messages.
 */
export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const handler = TOOLS[name]

  if (!handler) {
    return {
      success: false,
      error: `Unknown tool: "${name}". Available tools: ${TOOL_NAMES.join(', ')}`,
    }
  }

  try {
    return await handler(input as Record<string, unknown>, ctx)
  } catch (err) {
    ctx.logger.error({ err, tool: name }, 'Unhandled error in tool handler')
    return { success: false, error: `Tool "${name}" threw unexpectedly: ${String(err)}` }
  }
}
