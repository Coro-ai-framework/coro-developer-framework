import type { Job, WorkflowPhase } from '../types'

/**
 * Phase list for a job. `workflowPhases` is the runner's snapshot of the
 * workflow file — `GET /jobs/:jobId` backfills it, but the `GET /jobs` list
 * payload does not, and jobs created before the field existed have none. In
 * those cases reconstruct from the phases that actually ran plus the
 * current one, so the strip is never empty for a live run.
 */
export function deriveWorkflowPhases(job: Job | null): WorkflowPhase[] {
  if (!job) return []
  if (job.workflowPhases && job.workflowPhases.length > 0) return job.workflowPhases

  const seen = new Set<string>()
  const phases: WorkflowPhase[] = []
  for (const phase of job.phaseUsage ?? []) {
    if (!seen.has(phase.phase)) {
      seen.add(phase.phase)
      phases.push({ name: phase.phase, status: phase.phase })
    }
  }
  if (job.phase && !seen.has(job.phase)) {
    phases.push({ name: job.phase, status: job.phase })
  }
  return phases
}
