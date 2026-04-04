import { ToolContext } from './types'

export async function lokiQuery(
  input: { logQL: string; start: string; end?: string; limit?: number },
  ctx: ToolContext,
): Promise<unknown> {
  return await ctx.lokiClient.query(input.logQL, input.start, input.end ?? 'now', input.limit ?? 500)
}

export async function tempoGetTrace(
  input: { traceId: string },
  ctx: ToolContext,
): Promise<unknown> {
  return await ctx.tempoClient.getTrace(input.traceId)
}

export async function tempoSearch(
  input: { query: string; start: string; end?: string; limit?: number },
  ctx: ToolContext,
): Promise<unknown> {
  return await ctx.tempoClient.search(input.query, input.start, input.end, input.limit ?? 20)
}
