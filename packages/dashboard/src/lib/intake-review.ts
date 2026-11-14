import type { ActivityItem } from '../components/activity/types'

// Plan mode proposes a pull-request review with a <review> block; the
// dashboard hides the block and renders a card with a "Start review" button.

export interface ReviewRequest {
  prUrl: string
  note: string
}

const REVIEW_TAG = /<review>\s*([\s\S]*?)\s*<\/review>/i

const PR_PATTERNS: RegExp[] = [
  /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+/i,
  /^https?:\/\/[^\s]+\/-\/merge_requests\/\d+/i,
  /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull-requests\/\d+/i,
  /^[\w.-]+\/[\w.-]+#\d+$/,
]

/** True for a GitHub, GitLab or Bitbucket pull-request URL, or `owner/repo#123`. */
export function isPullRequestRef(value: string): boolean {
  const trimmed = value.trim()
  return PR_PATTERNS.some(pattern => pattern.test(trimmed))
}

export function parseReviewRequest(assistantMessage: string): ReviewRequest | null {
  const match = assistantMessage.match(REVIEW_TAG)
  if (!match?.[1]) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1].trim())
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const prUrl = typeof record.prUrl === 'string' ? record.prUrl.trim() : ''
  if (!prUrl || !isPullRequestRef(prUrl)) return null
  const note = typeof record.note === 'string' ? record.note.trim() : ''
  return { prUrl, note }
}

/**
 * One identity per pull request, so the same PR proposed twice gets one card:
 * lower-cased host, no trailing slash, and no sub-page (`/files`, `/commits`…).
 */
export function normalizePrUrl(prUrl: string): string {
  const trimmed = prUrl.trim()
  if (!/^https?:\/\//i.test(trimmed)) return trimmed.toLowerCase()
  try {
    const url = new URL(trimmed)
    const path = url.pathname.replace(/\/+$/, '')
    const pr = /^(.*?\/(?:pull|pull-requests|merge_requests)\/\d+)/i.exec(path)
    return `${url.protocol}//${url.host.toLowerCase()}${(pr?.[1] ?? path).toLowerCase()}`
  } catch {
    return trimmed.toLowerCase()
  }
}

export interface ReviewCardData {
  prUrl: string
  note: string
  state: 'draft' | 'started'
  reviewId?: string
}

/**
 * Adds a draft review card for the reply's <review> block, unless this
 * conversation already has a card for the same pull request.
 */
export function withReviewCard(items: ActivityItem[], assistant: string, cardId: string): ActivityItem[] {
  const request = parseReviewRequest(assistant)
  if (!request) return items
  const key = normalizePrUrl(request.prUrl)
  const exists = items.some(
    item => item.kind === 'card'
      && item.card.type === 'review'
      && normalizePrUrl((item.card.data as ReviewCardData).prUrl) === key,
  )
  if (exists) return items
  const data: ReviewCardData = { prUrl: request.prUrl, note: request.note, state: 'draft' }
  return [...items, { kind: 'card', id: cardId, card: { type: 'review', data } }]
}
