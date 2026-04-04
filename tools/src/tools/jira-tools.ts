import { ToolContext } from './types'

export async function jiraGetIssue(
  input: { ticketId: string },
  ctx: ToolContext,
): Promise<unknown> {
  return await ctx.jiraClient.getIssue(input.ticketId)
}

export async function jiraPostComment(
  input: { ticketId: string; body: string },
  ctx: ToolContext,
): Promise<unknown> {
  return await ctx.jiraClient.postComment(input.ticketId, input.body)
}

export async function jiraTransitionIssue(
  input: { ticketId: string; transitionId: string },
  ctx: ToolContext,
): Promise<unknown> {
  const result = await ctx.jiraClient.transitionIssue(input.ticketId, input.transitionId)
  return result ?? { transitioned: true }
}
