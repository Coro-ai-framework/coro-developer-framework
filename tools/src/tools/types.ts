import { ChildProcess } from 'child_process'
import { Logger } from 'pino'
import { BitBucketClient } from '../clients/bitbucket'
import { GitClient } from '../clients/git'
import { JiraClient } from '../clients/jira'
import { LokiClient } from '../clients/loki'
import { TempoClient } from '../clients/tempo'
import { Settings } from '../config/settings'
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
// MCP tool handlers set these on the shared PhaseSignals object. The runner
// reads them after each query() completes to decide what to do next.
//
// Default behavior (no signals set): auto-advance to the next workflow phase.
// Signals are only needed for EXCEPTIONS to the normal flow:
//   await_event  → park the job, waiting for an external event
//   escalate     → stop the job, human intervention needed
//   goto_phase   → override which phase comes next (e.g. loop back to coding)
//   phaseComplete → optional early-break hint (not required — the runner
//                   auto-advances regardless when the query stream ends)

export interface PhaseSignals {
  phaseComplete?: boolean
  /** When set, overrides the default next-phase lookup. Used by goto_phase. */
  nextPhase?: string
  awaitingEvent?: string
  awaitingPrId?: number
  escalated?: boolean
  escalationReason?: string
}
