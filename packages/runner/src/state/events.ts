// ── Event types for EventTransport ────────────────────────────────────────────
//
// These types flow between the runner and external event sources (webhooks,
// cloud control plane, polling). They are transport-agnostic — the same types
// work whether events arrive via in-process call, WebSocket, or polling.

/**
 * Event received from an external source (BitBucket webhook, Jira webhook,
 * cloud-forwarded event, or polling result).
 */
export interface InboundEvent {
  source: 'bitbucket' | 'jira'
  eventKey: string
  payload: Record<string, unknown>
  receivedAt: string
}

/**
 * Event emitted by the runner toward the control plane.
 * In-process transport ignores these; cloud transport sends via WebSocket.
 */
export interface OutboundEvent {
  type: 'job:log' | 'job:update' | 'job:complete' | 'job:park' | 'runner:heartbeat'
  jobId: string
  data: Record<string, unknown>
}
