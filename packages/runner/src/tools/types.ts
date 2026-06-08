import { Logger } from 'pino'
import type { HookPolicy, McpServerDescriptor, PhaseExecutorRuntime, PluginMcpServerConfig } from '@coro-ai/plugin-sdk'
import { BitBucketClient } from '../clients/bitbucket'
import { GitHubClient } from '../clients/github'
import { GitClient } from '../clients/git'
import { LokiClient } from '../clients/loki'
import { TempoClient } from '../clients/tempo'
import { Settings } from '../config/settings'
import type { TenantContext } from '../intelligence/tenant-context'
import type { PluginRegistry } from '../plugins/registry'
import type { StateBackend } from '../state/backend'
import { Job } from '@coro-ai/cloud-protocol'
import type { PhaseConfig } from '../workflow-parser'

// ── Tool execution context ────────────────────────────────────────────────────
//
// Shared mutable state passed to every MCP tool handler.
// The `job` field is swapped between phases by the runner.
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
  /**
   * Plugin registry shared with the runner. MCP tools dispatch
   * `scm_*` / `tracker_*` calls through this — the registry is the
   * single source of truth for which SCM / tracker plugin is active.
   */
  plugins: PluginRegistry
  logger: Logger
  /**
   * Live phase context — set by the runner at every phase boundary,
   * before the in-process MCP server is created. Used by the
   * `run_subagent` MCP tool to dispatch a side-conversation through
   * the parent phase's executor (or a different one when the workflow
   * declares `subagents: [{ provider: ... }]`). Undefined outside a
   * phase invocation (test fixtures, bootstrap).
   */
  currentPhase?: CurrentPhaseContext
}

/**
 * Per-phase snapshot captured by the runner once it has resolved the
 * executor + intelligence layer + plugin MCP servers for the active
 * phase. Mutable: re-assigned wholesale at every phase boundary.
 */
export interface CurrentPhaseContext {
  /** Resolved phase config from the active workflow YAML. */
  phaseConf: PhaseConfig
  /** Executor selected for this phase (for capability gating + fallback). */
  executor: PhaseExecutorRuntime
  /** Per-phase working directory (absolute). */
  workingDir: string
  /** Materialised intelligence overlay for this job (absolute). */
  jobIntelligenceDir: string
  /** Hook policy in effect for this phase (subagents inherit + narrow). */
  hookPolicy: HookPolicy
  /** Coro MCP server descriptor handed to the executor. */
  mcpServer: McpServerDescriptor
  /** Plugin MCP servers attached to this phase. */
  pluginMcpServers: Record<string, PluginMcpServerConfig>
  /** Phase names from the active workflow; used to validate goto_phase targets. */
  declaredPhases?: string[]
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
