/**
 * Error shapes surfaced when the Claude Agent SDK aborts an in-flight tool
 * call after `Query.interrupt()` (developer steering or pause). These are
 * expected control-flow exits, not infrastructure crashes.
 */

const EDE_DIAGNOSTIC_RE = /\[ede_diagnostic\]/i
const REQUEST_ABORTED_RE = /request was aborted/i

/** True for SDK steering/interrupt payloads (result errors or thrown messages). */
export function isSteeringDiagnosticText(text: string): boolean {
  return EDE_DIAGNOSTIC_RE.test(text) || REQUEST_ABORTED_RE.test(text)
}

/** True when `err` looks like an SDK interrupt / aborted-tool diagnostic. */
export function isRecoverableSteeringAbort(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return isSteeringDiagnosticText(msg)
}

/** True when tool_result text indicates a broken MCP transport. */
export function isMcpTransportErrorText(text: string): boolean {
  return /stream closed|request aborted|process\s*transport is not ready|mcp(?:\s+|.*)(?:error|closed|disconnected)|connection closed/i.test(
    text,
  )
}

/** True when MCP heal should not be retried (subprocess dead or account limit). */
export function isMcpHealExhaustedError(text: string): boolean {
  return (
    isMcpInputDeadText(text) ||
    /process\s*transport is not ready|you['']ve hit your limit|rate.?limit|exited with code/i.test(text)
  )
}

/**
 * True when the Claude Code control-request channel is permanently closed.
 * `setMcpServers` cannot recover from this — only ending the phase / query helps.
 */
export function isMcpInputDeadText(text: string): boolean {
  return /inputClosed|Stream closed/i.test(text)
}

/**
 * Whether closing the phase pushable after a `result` event is safe.
 * Closing on steering/interrupt (`interrupted`, `tool_use`) kills MCP;
 * never closing leaves the query stream open forever after the agent's
 * final `end_turn` and the runner never advances phases.
 */
export function shouldClosePushableAfterResult(stopReason: string): boolean {
  return stopReason === 'end_turn' || stopReason === 'max_turns' || stopReason === 'stop'
}
