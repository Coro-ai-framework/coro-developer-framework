import { ToolContext, ToolResult } from './types'
import { wrap } from './wrap'
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
// wrap() handles try/catch uniformly — tool functions just return output or throw.
//
// Adding a new tool:
//   1. Add its schema to config/tool-definitions.yaml
//   2. Implement it in the appropriate file under src/tools/
//   3. Register it here
//   Done — the runner picks it up automatically.

type ToolHandler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>

const TOOLS: Record<string, ToolHandler> = {
  read_file:        wrap(readFile),
  write_file:       wrap(writeFile),
  list_directory:   wrap(listDirectory),
  create_directory: wrap(createDirectory),

  git_clone:           wrap(gitClone),
  git_checkout_branch: wrap(gitCheckoutBranch),
  git_commit:          wrap(gitCommit),
  git_push:            wrap(gitPush),
  git_diff:            wrap(gitDiff),
  git_status:          wrap(gitStatus),

  bb_create_repo:      wrap(bbCreateRepo),
  bb_create_pr:        wrap(bbCreatePr),
  bb_get_pr_status:    wrap(bbGetPrStatus),
  bb_get_pr_comments:  wrap(bbGetPrComments),
  bb_post_pr_comment:  wrap(bbPostPrComment),
  bb_reply_to_comment: wrap(bbReplyToComment),
  bb_approve_pr:       wrap(bbApprovePr),
  bb_merge_pr:         wrap(bbMergePr),

  run_go_build:     wrap(runGoBuild),
  start_go_service: wrap(startGoService),
  stop_go_service:  wrap(stopGoService),
  compare_request:  wrap(compareRequest),

  loki_query:    wrap(lokiQuery),
  tempo_get_trace: wrap(tempoGetTrace),
  tempo_search:  wrap(tempoSearch),

  jira_get_issue:        wrap(jiraGetIssue),
  jira_post_comment:     wrap(jiraPostComment),
  jira_transition_issue: wrap(jiraTransitionIssue),

  mark_phase_complete: wrap(markPhaseComplete),
  await_event:         wrap(awaitEvent),
  escalate:            wrap(escalate),
  log:                 wrap(log),
  propose_change:      wrap(proposeChange),
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

  return await handler(input as Record<string, unknown>, ctx)
}
