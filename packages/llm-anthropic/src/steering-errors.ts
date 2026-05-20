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
  return /process\s*transport is not ready|you['']ve hit your limit|rate.?limit|exited with code/i.test(
    text,
  )
}
