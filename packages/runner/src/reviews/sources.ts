import type { ReviewEvent } from '@coro-ai/cloud-protocol'

export type ReviewEventSink = (event: ReviewEvent) => Promise<void>

/** Anything that can deliver review events. Pollers, CI, and webhooks share it. */
export interface ReviewEventSource {
  start(sink: ReviewEventSink): Promise<void> | void
  stop(): Promise<void> | void
}
