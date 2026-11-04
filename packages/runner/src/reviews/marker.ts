import { gzipSync, gunzipSync } from 'zlib'
import type { PrReview, ReviewRoundSummary } from '@coro-ai/cloud-protocol'

const STATE_RE = /<!-- coro-review-state:v1 ([A-Za-z0-9+/=]+) -->/
const MAX_BODY = 60_000

export function encodeReviewState(review: PrReview): string {
  const payload = Buffer.from(JSON.stringify(review), 'utf8')
  return gzipSync(payload).toString('base64')
}

export function decodeReviewState(body: string): PrReview | null {
  const match = body.match(STATE_RE)
  if (!match?.[1]) return null
  try {
    const json = gunzipSync(Buffer.from(match[1], 'base64')).toString('utf8')
    return JSON.parse(json) as PrReview
  } catch {
    return null
  }
}

export function renderSummaryComment(review: PrReview): string {
  const findings = review.ledger.findings
  const open = findings.filter(f => f.status === 'open')
  const lines = [
    `## Coro review`,
    '',
    `Status: **${review.status}** · rounds: ${review.totals.rounds} · cost: $${review.totals.costUsd.toFixed(2)}`,
    '',
    `| Round | Kind | Outcome | Summary |`,
    `| --- | --- | --- | --- |`,
    ...review.rounds.slice(-12).map(round =>
      `| ${round.round} | ${round.kind} | ${round.outcome} | ${escapeCell(round.summary)} |`),
    '',
    `Open findings: ${open.length}`,
    ...open.slice(0, 20).map(f => `- **${f.severity}** ${f.title}${f.path ? ` (\`${f.path}\`)` : ''}`),
    '',
    `<!-- coro-review-state:v1 ${encodeReviewState(trimForMarker(review))} -->`,
  ]
  let body = lines.join('\n')
  if (body.length > MAX_BODY) {
    const trimmed = trimForMarker(review, 4)
    body = [
      `## Coro review`,
      '',
      `Status: **${review.status}** · ${review.totals.rounds} rounds (older rounds trimmed).`,
      '',
      `<!-- coro-review-state:v1 ${encodeReviewState(trimmed)} -->`,
    ].join('\n')
  }
  return body
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 180)
}

/** Drop old round summaries and closed findings so the sticky comment fits. */
export function trimForMarker(review: PrReview, keepRounds = 8): PrReview {
  const rounds: ReviewRoundSummary[] = review.rounds.slice(-keepRounds)
  const findings = [
    ...review.ledger.findings.filter(f => f.status === 'open'),
    ...review.ledger.findings.filter(f => f.status !== 'open').slice(-20),
  ]
  return {
    ...review,
    rounds,
    pendingEvents: [],
    ledger: { ...review.ledger, findings },
  }
}
