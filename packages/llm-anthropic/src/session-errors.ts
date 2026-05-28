/**
 * Errors surfaced when Claude Code resumes a persisted session whose upstream
 * transcript is no longer valid (expired session, provider reset after long
 * pause/rate-limit, etc.).
 */

const CLAUDE_CODE_ERROR_RESULT_RE = /claude code returned an error result/i
const STALE_RESUME_DIAGNOSTIC_RE =
  /previous_message_id|prior \/v1\/messages response|starts with [`']?msg_/i

/** True when `err` indicates `resume: sessionId` cannot be honored. */
export function isStaleSessionResumeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  if (!CLAUDE_CODE_ERROR_RESULT_RE.test(msg) && !/API Error:\s*400/i.test(msg)) {
    return false
  }
  return STALE_RESUME_DIAGNOSTIC_RE.test(msg)
}
