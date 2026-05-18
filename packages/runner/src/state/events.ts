// ── Event types for EventTransport ────────────────────────────────────────────
//
// These types flow between the runner and external event sources (webhooks,
// cloud control plane, polling). They are transport-agnostic — the same types
// work whether events arrive via in-process call, WebSocket, or polling.

import type { ExternalRef } from '@coro/cloud-protocol'

/**
 * Source of an inbound event.
 *
 * - `plugin` — third-party webhook payload routed through a plugin's
 *   `normalizeInbound`. The runner identifies the source by the
 *   `pluginId` carried alongside the event; the dispatcher then uses
 *   `ref` (an {@link ExternalRef}) to wake the parked job that owns
 *   it. Polling transports also emit `'plugin'` events: the SCM
 *   plugin's `pollPr` produced the snapshot and the transport just
 *   carries the resulting `ref` into the dispatcher.
 * - `cloud` — control-plane originated commands (manual resume,
 *   developer message, etc.) addressed to a specific jobId. The
 *   payload carries the jobId directly — there is no provider lookup.
 *
 * Adding a new source means extending this union and adding a matching
 * branch in `Dispatcher.handleWebhookEvent`. The provider-named values
 * (`'bitbucket'`, `'jira'`) that lived here pre-P4 have been retired —
 * provider knowledge belongs in plugins, not in the event envelope.
 */
export type InboundEventSource = 'plugin' | 'cloud'

/**
 * Event received from an external source (provider webhook normalised
 * by a plugin, cloud-forwarded command, or polling result).
 *
 * `pluginId` and `ref` populate the plugin path:
 *  - `pluginId` is REQUIRED on `'plugin'` events. It identifies which
 *    plugin produced the normalisation (and which plugin the
 *    dispatcher should route the wake-up through if the job needs
 *    further interaction).
 *  - `ref` is the {@link ExternalRef} returned by the plugin's
 *    `normalizeInbound`. The dispatcher uses it to look up the parked
 *    job via {@link StateBackend.getJobByExternalRef}.
 *
 * On `'cloud'` events both fields stay undefined and the payload
 * carries `jobId` directly.
 */
export interface InboundEvent {
  source: InboundEventSource
  /** Provider-native event key (e.g. `pullrequest:fulfilled`, `jira:issue_updated`). */
  eventKey: string
  payload: Record<string, unknown>
  receivedAt: string
  /** Set when source is `'plugin'`; omitted on cloud-control events. */
  pluginId?: string
  /** Plugin-normalised reference to the external object the event concerns. */
  ref?: ExternalRef
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
