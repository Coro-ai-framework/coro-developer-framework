// ── Lens funnel statistics ───────────────────────────────────────────────────
//
// A lens that is mostly noise is invisible in a cost column. What tells it
// apart is the funnel after it: how many findings it raised, how many the
// runner dropped and why, how many the verifier kept, how many reached the
// pull request, and what became of those. These helpers keep one round's
// `lensCosts` entry up to date from the places that know each fact.

import type {
  Finding,
  FindingResolution,
  FindingStatus,
  LensRoundStats,
  PrReview,
  ReviewRoundSummary,
} from '@coro-ai/cloud-protocol'
import { sameFinding, type MatchableFinding } from './finding-match'

function emptyStats(): LensRoundStats {
  return { costUsd: 0, inputTokens: 0, outputTokens: 0, findings: 0 }
}

/** The round entry for one job, or the one numbered `round`. */
export function roundOf(review: PrReview, by: { jobId: string } | { round: number }): ReviewRoundSummary | undefined {
  if ('jobId' in by) return [...review.rounds].reverse().find(item => item.jobId === by.jobId)
  return review.rounds.find(item => item.round === by.round)
}

export function statsFor(round: ReviewRoundSummary, lens: string): LensRoundStats {
  round.lensCosts ??= {}
  round.lensCosts[lens] ??= emptyStats()
  return round.lensCosts[lens]!
}

export function addDropped(stats: LensRoundStats, reason: string, count = 1): void {
  stats.droppedByRunner = { ...(stats.droppedByRunner ?? {}), [reason]: (stats.droppedByRunner?.[reason] ?? 0) + count }
}

/**
 * Which lens raised each finding the verifier kept. A verifier may reword a
 * title and drop the `lens` field, so a kept finding falls back to matching
 * the candidate it came from.
 */
export function attributeKept(
  candidates: unknown[] | undefined,
  kept: (MatchableFinding & { lens?: string })[],
): Map<string, number> {
  const known = (candidates ?? []).filter(
    (item): item is MatchableFinding & { lens?: string } =>
      !!item && typeof item === 'object' && typeof (item as { title?: unknown }).title === 'string',
  )
  const counts = new Map<string, number>()
  for (const finding of kept) {
    const lens = finding.lens ?? known.find(candidate => sameFinding(candidate, finding))?.lens
    if (!lens) continue
    counts.set(lens, (counts.get(lens) ?? 0) + 1)
  }
  return counts
}

const SETTLED: ReadonlySet<FindingStatus> = new Set(['addressed', 'declined', 'outdated', 'withdrawn'])

/**
 * Moves a finding to a new status and keeps the bookkeeping that depends on
 * the move: `resolution` (so a thread closed with the pull request is not
 * mistaken for a fixed one) and the raising lens's addressed/declined tally.
 * Only a move out of `open` counts, so setting the same status twice is free.
 */
export function settleFinding(
  review: PrReview,
  finding: Finding,
  next: FindingStatus,
  resolution?: FindingResolution,
): void {
  const wasOpen = finding.status === 'open'
  finding.status = next
  if (next === 'open') {
    delete finding.resolution
    return
  }
  if (!wasOpen || !SETTLED.has(next)) return
  const how = resolution ?? (next === 'addressed' ? 'resolved' : undefined)
  if (how) finding.resolution = how
  if (how === 'closed-open') return
  if (next !== 'addressed' && next !== 'declined') return
  const round = roundOf(review, { round: finding.raisedInRound })
  const stats = round?.lensCosts?.[finding.lens]
  if (!stats) return
  if (next === 'addressed') stats.addressed = (stats.addressed ?? 0) + 1
  else stats.declined = (stats.declined ?? 0) + 1
}
