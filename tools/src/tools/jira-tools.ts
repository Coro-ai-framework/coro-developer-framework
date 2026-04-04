import { ToolContext, ToolResult } from './types'

// ── Tools ─────────────────────────────────────────────────────────────────────
//
// All methods delegate to JiraClient which returns { available: false } when
// Jira is not configured. Registered now so agent MD files can reference them
// without any code changes when Jira support is added.

export async function jiraGetIssue(
  input: { ticketId: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const result = await ctx.jiraClient.getIssue(input.ticketId)
    return { success: true, output: result }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function jiraPostComment(
  input: { ticketId: string; body: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const result = await ctx.jiraClient.postComment(input.ticketId, input.body)
    return { success: true, output: result }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function jiraTransitionIssue(
  input: { ticketId: string; transitionId: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const result = await ctx.jiraClient.transitionIssue(input.ticketId, input.transitionId)
    return { success: true, output: result ?? { transitioned: true } }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
