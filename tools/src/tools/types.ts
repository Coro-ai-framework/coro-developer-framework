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
// Passed to every tool implementation. Tools read job state, call external
// clients, and mutate job._signals — but never return until their action
// is complete. The runner reads _signals after each full Claude turn.

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
  /** Long-running Go service processes started by the test harness, keyed by a label. */
  runningServices: Map<string, ChildProcess>
}

// ── Tool result ───────────────────────────────────────────────────────────────
//
// `output` is serialised to JSON and sent back to Claude as the tool_result
// content. Keep it concise — large blobs eat context budget.

export interface ToolResult {
  success: boolean
  output?: unknown
  error?: string
}
