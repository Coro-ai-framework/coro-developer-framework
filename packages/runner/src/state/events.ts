// ── Event types for EventTransport ────────────────────────────────────────────
//
// These types flow between the runner and external event sources (webhooks,
// cloud control plane, polling). They are transport-agnostic — the same types
// work whether events arrive via in-process call, WebSocket, or polling.

/**
 * Source of an inbound event.
 *
 * - `bitbucket` / `jira` — third-party PR/issue webhook payloads. Identified
 *   by their native PR id / issue key, used by the dispatcher to wake parked
 *   jobs.
 * - `cloud` — control-plane originated commands (manual resume, developer
 *   message, etc.) addressed to a specific jobId. The payload is not a
 *   third-party shape — it carries the jobId directly.
 *
 * Adding a new source means extending this union and adding a matching
 * branch in `Dispatcher.handleWebhookEvent`.
 */
export type InboundEventSource = 'bitbucket' | 'jira' | 'cloud'

/**
 * Event received from an external source (BitBucket webhook, Jira webhook,
 * cloud-forwarded event, or polling result).
 */
export interface InboundEvent {
  source: InboundEventSource
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
