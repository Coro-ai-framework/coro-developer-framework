/**
 * Error shapes surfaced when the Claude Agent SDK aborts an in-flight tool
 * call after `Query.interrupt()` (developer steering or pause). These are
 * expected control-flow exits, not infrastructure crashes.
 */

const EDE_DIAGNOSTIC_RE = /\[ede_diagnostic\]/i
const REQUEST_ABORTED_RE = /request was aborted/i

/** True when `err` looks like an SDK interrupt / aborted-tool diagnostic. */
export function isRecoverableSteeringAbort(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return EDE_DIAGNOSTIC_RE.test(msg) || REQUEST_ABORTED_RE.test(msg)
}

/** True when tool_result text indicates a broken MCP transport. */
export function isMcpTransportErrorText(text: string): boolean {
  return /stream closed|request aborted|mcp(?:\s+|.*)(?:error|closed|disconnected)|connection closed/i.test(
    text,
  )
}
