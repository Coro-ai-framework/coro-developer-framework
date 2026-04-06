import { ChildProcess } from 'child_process'
import { Logger } from 'pino'
import { BitBucketClient } from '../clients/bitbucket'
import { GitClient } from '../clients/git'
import { JiraClient } from '../clients/jira'
import { LokiClient } from '../clients/loki'
import { TempoClient } from '../clients/tempo'
import { Settings } from '../config/settings'
import { JobRegistry } from '../jobs/registry'
import { Job } from '../jobs/types'

// ── Tool execution context ────────────────────────────────────────────────────
//
// Shared mutable state passed to every MCP tool handler.
// The `job` field is swapped between phases by the runner.
// `runningServices` tracks Go processes started by the test harness.

export interface ToolContext {
  job: Job
  registry: JobRegistry
  settings: Settings
  gitClient: GitClient
  bbCoder: BitBucketClient
  bbReviewer: BitBucketClient
  lokiClient: LokiClient
  tempoClient: TempoClient
  jiraClient: JiraClient
  logger: Logger
  runningServices: Map<string, ChildProcess>
}

// ── Job-control signal types ──────────────────────────────────────────────────
//
// MCP tool handlers for mark_phase_complete / await_event / escalate set these
// on the shared PhaseSignals object. The runner reads them after each query()
// completes (or via hooks) to decide what to do next.

export interface PhaseSignals {
  phaseComplete?: boolean
  /** When set alongside phaseComplete, overrides the default next-phase lookup. */
  nextPhase?: string
  awaitingEvent?: string
  awaitingPrId?: number
  escalated?: boolean
  escalationReason?: string
}
