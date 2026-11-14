import type { Job } from '@coro-ai/cloud-protocol'

/**
 * `GET /jobs?view=summary`: a job without the fields only its own page
 * reads. Insights, artefacts, decision records and per-phase usage are most
 * of a job's weight — on a runner with a hundred jobs, 80% of an
 * eight-megabyte list — and no list, table or picker uses them. The shape
 * stays a `Job` (empty arrays for required fields) so callers need no
 * second type.
 */
export function toJobListView(job: Job): Job {
  const {
    insights: _insights,
    artifacts: _artifacts,
    decisionRecords: _decisionRecords,
    phaseUsage: _phaseUsage,
    campaignAggregatedInsights: _aggregated,
    intelligenceProvenance: _provenance,
    workflowPathHistory: _history,
    workflowPhases: _phases,
    pendingPrompt: _pendingPrompt,
    ...rest
  } = job as Job & Record<string, unknown>
  return { ...rest, insights: [], artifacts: [], phaseUsage: [] } as unknown as Job
}
