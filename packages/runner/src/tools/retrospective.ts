// ── Retrospective-scoped tool guard ──────────────────────────────────────────
//
// The retrospective workflow gets a wider surface than any other job: it
// reads the whole install's job history and (in later phases) opens issues
// and PRs against the upstream Coro repository. None of that belongs to an
// ordinary implementation job, so every retrospective-only tool starts by
// asserting the calling job's type.
//
// Gating on `job.type` rather than on the workflow path keeps the check
// honest when a tenant renames or overrides the retrospective workflow
// file: the type is stamped at dispatch time by the runner, not chosen by
// the agent.

import { isRetrospectiveJob } from '../jobs/helpers'
import type { ToolContext } from './types'

export function assertRetrospectiveJob(ctx: ToolContext, toolName: string): void {
  if (isRetrospectiveJob(ctx.job)) return
  throw new Error(
    `${toolName} is only available to retrospective jobs (this job is type "${ctx.job.type}"). ` +
    'Cross-job history and upstream contribution tools are reserved for the retrospective ' +
    'workflow — record what you learned with add_insight instead.',
  )
}
