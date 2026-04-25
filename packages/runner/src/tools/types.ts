import { ChildProcess } from 'child_process'
import { Logger } from 'pino'
import { BitBucketClient } from '../clients/bitbucket'
import { GitHubClient } from '../clients/github'
import { GitClient } from '../clients/git'
import { JiraClient } from '../clients/jira'
import { LokiClient } from '../clients/loki'
import { TempoClient } from '../clients/tempo'
import { Settings } from '../config/settings'
import type { TenantContext } from '../intelligence/tenant-context'
import type { StateBackend } from '../state/backend'
import { Job } from '../jobs/types'

// ── Tool execution context ────────────────────────────────────────────────────
//
// Shared mutable state passed to every MCP tool handler.
// The `job` field is swapped between phases by the runner.
// `runningServices` tracks Go processes started by the test harness.

export interface ToolContext {
  job: Job
  stateBackend: StateBackend
  settings: Settings
  /**
   * Tenant the active job belongs to. Tools that touch tenant-scoped
   * state (memory, proposals) read this so writes are routed to the
   * right layer.
   */
  tenantContext: TenantContext
  /**
   * Absolute path to the per-job materialised intelligence overlay
   * (created by {@link resolveJobIntelligence}). Tools should prefer
   * this over `settings.paths.coroIntelligenceDir` when reading
   * workflow / agent / skill markdown for the active job.
   */
  jobIntelligenceDir: string
  gitClient: GitClient
  bbCoder: BitBucketClient
  bbReviewer: BitBucketClient
  ghClient: GitHubClient | null
  ghGitClient: GitClient | null
  lokiClient: LokiClient
  tempoClient: TempoClient
  jiraClient: JiraClient
  logger: Logger
  runningServices: Map<string, ChildProcess>
}

// ── Job-control signal types ──────────────────────────────────────────────────
//
// MCP tool handlers set these on the shared PhaseSignals object. The runner
// reads them after each query() completes to decide what to do next.
//
// Default behavior (no signals set): auto-advance to the next workflow phase.
// Signals are only needed for EXCEPTIONS to the normal flow:
//   await_event  → park the job, waiting for an external event
//   escalate     → stop the job, human intervention needed
//   goto_phase   → override which phase comes next (e.g. loop back to coding)

export interface PhaseSignals {
  /** When set, overrides the default next-phase lookup. Used by goto_phase. */
  nextPhase?: string
  awaitingEvent?: string
  awaitingPrId?: number
  escalated?: boolean
  escalationReason?: string
}
