/**
 * Shapes the harness writes to disk. They are the harness's own contract, not
 * Coro's: results written today must stay readable when Coro's job record
 * changes, so nothing here is derived from a Coro type.
 */

/** How an attempt ended, from the harness's point of view. */
export type AttemptOutcome =
  /** Job status `complete`. */
  | 'complete'
  /** Job status `failed`. */
  | 'failed'
  /** Job status `escalated`: the job stopped and told a human. */
  | 'escalated'
  /** Job status `cancelled` (nobody here cancels it except the timeout path). */
  | 'cancelled'
  /** Parked waiting for a person to answer or approve something nobody here will. */
  | 'needs-human'
  /** The task's timeout elapsed; the harness cancelled the job. */
  | 'timeout'
  /** The runner process died while the job was running. */
  | 'runner-crashed'
  /** The runner would not start, or refused the dispatch. */
  | 'dispatch-error'

export interface TimelineEntry {
  /** ISO timestamp of the observation. */
  at: string
  /** Milliseconds since the job was dispatched. */
  elapsedMs: number
  status: string
  phase: string
  /** Something the harness did at this moment, e.g. `reviewer: approved PR 1`. */
  event?: string
}

export interface Timeline {
  dispatchedAt: string
  endedAt: string
  entries: TimelineEntry[]
}

/** Where the attempt's deliverable ended up in the sandbox repository. */
export interface Delivery {
  delivered: boolean
  /** Commit the fixture started from. */
  baseSha: string
  /** Commit that grading checked out (`eval/delivered`), when anything was delivered. */
  headSha?: string
  /** `merged`: the reviewer merged PR branches into main. `branches`: unmerged PR branches were combined. */
  via?: 'merged' | 'branches'
  /** Branches that contributed to the delivered commit. */
  branches: string[]
  /** Branches that could not be combined (conflicts, missing refs). */
  skippedBranches: string[]
}

/** Written next to each attempt as `attempt.json`. */
export interface AttemptMeta {
  runId: string
  taskId: string
  attempt: number
  outcome: AttemptOutcome
  /** Final `Job.status`, when a job record was read. */
  jobStatus?: string
  jobId?: string
  error?: string
  startedAt: string
  endedAt: string
  /** Time from dispatch to the end of the watch loop. */
  wallMs: number
  port?: number
  delivery?: Delivery
}

export interface JudgeScores {
  correctness: number
  scopeDiscipline: number
  readability: number
  testQuality: number
  /** Higher is better here too: 5 means low risk to merge. */
  risk: number
}

export type IssueSeverity = 'blocker' | 'major' | 'minor' | 'nit'

export interface JudgeIssue {
  severity: IssueSeverity
  file: string
  summary: string
}
