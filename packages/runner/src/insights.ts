// ── Insight propagation helpers ────────────────────────────────────────────────
//
// Insights stay on the job record for dashboard audit even when declined.
// These helpers define which entries may steer agents (system prompt) or
// campaign siblings (dispatcher aggregate / initialInsights seed).

import type { Insight } from '@coro/cloud-protocol'

/** True when the user soft-deleted or explicitly rejected this insight. */
export function isInsightRejected(insight: Insight): boolean {
  return insight.status === 'rejected'
}

/**
 * Insights that may propagate to campaign siblings or appear in the system
 * prompt. Rejected rows are omitted; pending and approved are kept so
 * proactive curation before the evaluator / next sibling dispatch can gate
 * what downstream agents see.
 */
export function propagableInsights(insights: readonly Insight[] | undefined): Insight[] {
  if (!insights?.length) return []
  return insights.filter(i => !isInsightRejected(i))
}
