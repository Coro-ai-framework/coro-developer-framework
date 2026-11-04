import type { InboundEvent, ReviewEvent, ReviewEventKind } from '@coro-ai/cloud-protocol'
import type { ReviewCoordinator } from './coordinator'

const KIND_BY_EVENT: Record<string, ReviewEventKind> = {
  'pr.review_requested': 'review-requested',
  'pr.review_request_removed': 'review-request-removed',
  'pr.updated': 'commits-pushed',
  'pr.synchronize': 'commits-pushed',
  'pr.commented': 'comment',
  'pr.review_submitted': 'review-submitted',
  'pr.approved': 'review-submitted',
  'pr.ready_for_review': 'ready-for-review',
  'pr.converted_to_draft': 'converted-to-draft',
  'pr.merged': 'merged',
  'pr.closed': 'closed',
  'pr.declined': 'closed',
  'pr.reopened': 'reopened',
}

/**
 * M4 seam. Review rounds never park, so a PR webhook is unmatched by the
 * dispatcher. This maps it onto a ReviewEvent. `review-requested` is
 * accepted only when the requested login matches the runner's identity.
 */
export function createWebhookReviewSink(
  coordinator: ReviewCoordinator,
  reviewerLogin: string,
): (event: InboundEvent) => Promise<void> {
  return async (event) => {
    if (!event.ref) return
    const kind = KIND_BY_EVENT[event.eventKey]
    if (!kind) return
    const raw = event.payload ?? {}
    if (kind === 'review-requested') {
      const requested = String(raw['requested_login'] ?? raw['requestedLogin'] ?? '')
      if (requested && requested !== reviewerLogin) return
    }
    const reviewEvent: ReviewEvent = {
      kind,
      prRef: event.ref,
      at: event.receivedAt || new Date().toISOString(),
      data: raw,
      source: 'webhook',
    }
    await coordinator.ingest(reviewEvent)
  }
}
