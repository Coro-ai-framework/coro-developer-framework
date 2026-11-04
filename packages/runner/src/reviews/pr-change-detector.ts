// ── PR change detector ───────────────────────────────────────────────────────
//
// Shared by the job polling transport (parked implementation jobs) and the
// review activity poller. The transport keeps its own cold-start rules;
// this function only describes the difference between two snapshots.

export interface DetectorSnapshot {
  state: string
  approvalCount: number
  commentCount: number
  headSha?: string
  draft?: boolean
  reviewRequested?: boolean
  threadCount?: number
  resolvedThreadCount?: number
}

export interface DetectorComment {
  id: string
  body: string
  createdAt: string
  author?: string
}

export interface DetectorDelta {
  eventKey: string
  payload: Record<string, unknown>
}

export function diffPrSnapshot(
  previous: DetectorSnapshot,
  current: DetectorSnapshot,
  comments: readonly DetectorComment[],
): DetectorDelta[] {
  const deltas: DetectorDelta[] = []

  if (current.state !== previous.state) {
    if (current.state === 'merged') {
      deltas.push({ eventKey: 'pullrequest:fulfilled', payload: { state: 'MERGED' } })
    } else if (current.state === 'declined') {
      deltas.push({ eventKey: 'pullrequest:rejected', payload: { state: 'DECLINED' } })
    } else {
      deltas.push({ eventKey: 'pullrequest:updated', payload: { state: current.state } })
    }
  } else if (current.headSha && previous.headSha && current.headSha !== previous.headSha) {
    deltas.push({ eventKey: 'pullrequest:updated', payload: { state: current.state, headSha: current.headSha } })
  }

  if (current.approvalCount > previous.approvalCount) {
    deltas.push({
      eventKey: 'pullrequest:approved',
      payload: { approvalCount: current.approvalCount },
    })
  }

  if (previous.draft === true && current.draft === false) {
    deltas.push({ eventKey: 'pullrequest:updated', payload: { ready: true } })
  }
  if (previous.draft === false && current.draft === true) {
    deltas.push({ eventKey: 'pullrequest:updated', payload: { draft: true } })
  }
  if (previous.reviewRequested === true && current.reviewRequested === false) {
    deltas.push({ eventKey: 'pullrequest:updated', payload: { reviewRequestRemoved: true } })
  }
  if (
    typeof current.resolvedThreadCount === 'number'
    && typeof previous.resolvedThreadCount === 'number'
    && current.resolvedThreadCount > previous.resolvedThreadCount
  ) {
    deltas.push({
      eventKey: 'pullrequest:updated',
      payload: { threadsResolved: current.resolvedThreadCount - previous.resolvedThreadCount },
    })
  }

  if (current.commentCount > previous.commentCount) {
    const fresh = comments.slice(previous.commentCount)
    for (const comment of fresh) {
      deltas.push({
        eventKey: 'pullrequest:comment_created',
        payload: {
          comment: {
            id: comment.id,
            content: { raw: comment.body },
            created_on: comment.createdAt,
            ...(comment.author ? { user: { display_name: comment.author } } : {}),
          },
        },
      })
    }
  }

  return deltas
}

/** Map a polling delta onto a review event kind. Unknown deltas are skipped. */
export function deltaToReviewKind(delta: DetectorDelta): string | null {
  if (delta.eventKey === 'pullrequest:fulfilled') return 'merged'
  if (delta.eventKey === 'pullrequest:rejected') return 'closed'
  if (delta.eventKey === 'pullrequest:comment_created') return 'comment'
  if (delta.eventKey === 'pullrequest:approved') return 'review-submitted'
  if (delta.eventKey !== 'pullrequest:updated') return null
  if (delta.payload['headSha']) return 'commits-pushed'
  if (delta.payload['ready'] === true) return 'ready-for-review'
  if (delta.payload['draft'] === true) return 'converted-to-draft'
  if (delta.payload['reviewRequestRemoved'] === true) return 'review-request-removed'
  if (delta.payload['threadsResolved']) return 'thread-resolved'
  return 'commits-pushed'
}
