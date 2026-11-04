import type { ExternalRef, InboundEvent, ReviewEvent, ReviewEventKind } from '@coro-ai/cloud-protocol'
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

type Raw = Record<string, unknown>

function obj(value: unknown): Raw | undefined {
  return value && typeof value === 'object' ? value as Raw : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/**
 * The login a review request names, if it names a person. Team requests
 * carry no login and are accepted, as the inbox's `review-requested:@me`
 * search accepts them.
 */
export function requestedReviewerLogin(raw: Raw): string | undefined {
  return str(obj(raw['requested_reviewer'])?.['login'])
    ?? str(raw['requested_login'])
    ?? str(raw['requestedLogin'])
}

/**
 * Webhook refs carry the bare repository name because parked jobs match
 * on it. Reviews are keyed by `owner/repo` everywhere else, so the review
 * id has to be built from the full name or a webhook opens a second review.
 */
function reviewRef(ref: ExternalRef, raw: Raw): ExternalRef {
  if (ref.repoKey?.includes('/')) return ref
  const fullName = str(obj(raw['repository'])?.['full_name'])
  return fullName ? { ...ref, repoKey: fullName } : ref
}

/** The fields the coordinator reads, in the shape the pollers produce. */
function eventData(kind: ReviewEventKind, raw: Raw): { data: Record<string, unknown>; actor?: string } {
  const pr = obj(raw['pull_request']) ?? obj(raw['pullrequest'])
  const comment = obj(raw['comment'])
  const review = obj(raw['review'])
  const data: Record<string, unknown> = {}
  const headSha = str(obj(pr?.['head'])?.['sha'])
  if (headSha) data['headSha'] = headSha
  const baseSha = str(obj(pr?.['base'])?.['sha'])
  if (baseSha) data['baseSha'] = baseSha
  if (pr) {
    if (str(pr['title'])) data['title'] = pr['title']
    if (str(pr['html_url'])) data['url'] = pr['html_url']
    const author = str(obj(pr['user'])?.['login'])
    if (author) data['author'] = author
    if (typeof pr['draft'] === 'boolean') data['draft'] = pr['draft']
  }
  const source = kind === 'comment' ? comment : kind === 'review-submitted' ? review : undefined
  if (source) {
    const body = str(source['body'])
    if (body) data['body'] = body
    if (source['id'] !== undefined) data['commentId'] = String(source['id'])
    const reply = source['in_reply_to_id']
    if (reply !== undefined && reply !== null) data['threadId'] = String(reply)
  }
  const actor = str(obj(source?.['user'])?.['login']) ?? str(obj(raw['sender'])?.['login'])
  return { data, ...(actor ? { actor } : {}) }
}

/**
 * Review rounds never park, so a PR webhook is unmatched by the
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
    if (kind === 'review-requested' || kind === 'review-request-removed') {
      const requested = requestedReviewerLogin(raw)
      if (requested && requested.toLowerCase() !== reviewerLogin.toLowerCase()) return
    }
    const { data, actor } = eventData(kind, raw)
    const reviewEvent: ReviewEvent = {
      kind,
      prRef: reviewRef(event.ref, raw),
      ...(actor ? { actor } : {}),
      at: event.receivedAt || new Date().toISOString(),
      data,
      source: 'webhook',
    }
    await coordinator.ingest(reviewEvent)
  }
}
