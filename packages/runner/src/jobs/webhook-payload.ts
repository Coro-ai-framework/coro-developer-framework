// ── Webhook payload helpers ───────────────────────────────────────────────────
//
// Tiny payload extractors for inbound third-party webhook payloads. Shared
// between the runner-side dispatcher (which uses them to wake parked jobs)
// and the cloud-side webhook router (which uses them to route the event to
// the runner that already owns the matching job, when there is one).
//
// Keeping these in one module avoids drift between the two callers. They
// intentionally do not normalise the payload itself — only extract the id
// that maps to a job. Provider-shape conversion is a separate concern
// tackled by the normalisation work in P2 of the team-mode plan.

/**
 * Extract a Bitbucket pull-request id from a Bitbucket webhook payload.
 *
 * Returns the numeric id, or `null` when the payload has no `pullrequest.id`
 * or the value cannot be parsed as a number.
 */
export function extractBbPrId(payload: Record<string, unknown>): number | null {
  const pr = payload['pullrequest'] as Record<string, unknown> | undefined
  const id = pr?.['id']
  if (typeof id === 'number') return id
  if (typeof id === 'string') {
    const n = parseInt(id, 10)
    return Number.isNaN(n) ? null : n
  }
  return null
}

/**
 * Extract a Jira issue key (e.g. `PROJ-123`) from a Jira webhook payload.
 *
 * Returns the key, or `null` when `issue.key` is absent or not a string.
 */
export function extractJiraTicketId(payload: Record<string, unknown>): string | null {
  const issue = payload['issue'] as Record<string, unknown> | undefined
  const key = issue?.['key']
  return typeof key === 'string' ? key : null
}
