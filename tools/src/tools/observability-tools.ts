import { ToolContext, ToolResult } from './types'

// ── Tools ─────────────────────────────────────────────────────────────────────
//
// All three tools degrade gracefully when Loki/Tempo are not configured.
// The agent receives { available: false, reason: "..." } and can continue
// without observability data — it should note this in its reasoning.

export async function lokiQuery(
  input: { logQL: string; start: string; end?: string; limit?: number },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const result = await ctx.lokiClient.query(
      input.logQL,
      input.start,
      input.end ?? 'now',
      input.limit ?? 500,
    )
    return { success: true, output: result }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function tempoGetTrace(
  input: { traceId: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const result = await ctx.tempoClient.getTrace(input.traceId)
    return { success: true, output: result }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function tempoSearch(
  input: { query: string; start: string; end?: string; limit?: number },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const result = await ctx.tempoClient.search(
      input.query,
      input.start,
      input.end,
      input.limit ?? 20,
    )
    return { success: true, output: result }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
