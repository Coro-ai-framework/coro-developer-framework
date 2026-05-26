// ── Job + Proposal wire types ────────────────────────────────────────────────
//
// The persistent, transport-level shape of a Coro job and its proposals.
// Lives in the wire-contract package because all three of runner, cloud
// control plane, and (future) plugin tools serialise / deserialise these
// envelopes. Runtime helpers that operate on these types (status
// predicates, param accessors, patch builders) stay runner-side under
// `packages/runner/src/jobs/helpers.ts` — only the shapes are shared.

// ── Job taxonomy ─────────────────────────────────────────────────────────────

/**
 * The type of work a job performs.
 * Determines which workflowPath is used and which phases are valid.
 */
export enum JobType {
  Job        = 'job',
  SelfUpdate = 'self-update',
}

// ── Well-known statuses ──────────────────────────────────────────────────────

export const STATUS_QUEUED                      = 'queued'
export const STATUS_COMPLETE                    = 'complete'
export const STATUS_CANCELLED                   = 'cancelled'
export const STATUS_ESCALATED                   = 'escalated'
export const STATUS_FAILED                      = 'failed'
export const STATUS_AWAITING_PLAN_APPROVAL      = 'awaiting-plan-approval'
export const STATUS_AWAITING_PR_MERGE           = 'awaiting-pr-merge'
export const STATUS_AWAITING_DEVELOPER_INPUT    = 'awaiting-developer-input'
/**
 * Campaign job status while parked in `coordinating`. The dispatcher's
 * child-completion hook resumes the parent out of this status once every
 * child reaches a terminal state.
 */
export const STATUS_AWAITING_CHILDREN           = 'awaiting-children'
export const STATUS_CODING                      = 'coding'

/**
 * Parked because the LLM provider returned a 429 / overloaded response.
 * The runner records a deadline + retry counter in `Job.rateLimitInfo`
 * and the in-process RateLimitScheduler resumes the job automatically
 * when the deadline expires. Distinct from `awaiting-developer-input`
 * so the dashboard can show a countdown and so dispatcher gates don't
 * confuse rate-limit parking with human-coordinated parking.
 */
export const STATUS_AWAITING_RATE_LIMIT         = 'awaiting-rate-limit'

/**
 * Marker `awaitingEvent` used when a developer pauses the job from the
 * dashboard (Pause button). Differentiates a developer-initiated park
 * from an agent-initiated one (which uses `developer-input: <reason>`
 * via the `await_event` tool). Both share the same lifecycle status —
 * `awaiting-developer-input` — so all the existing send-message-to-resume
 * machinery works unchanged. The dashboard reads `awaitingEvent` to
 * render a "Paused" badge instead of "Awaiting input" when this marker
 * is present.
 */
export const PAUSED_AWAITING_EVENT = 'developer-input: paused by developer'

// ── PR tracking ───────────────────────────────────────────────────────────────

export interface PrMapping {
  prId: number
  workItem: string
  repoSlug: string
  openedAt: string
  mergedAt?: string
}

// ── Work-item tracking ────────────────────────────────────────────────────────

export interface WorkItem {
  name: string
  status: 'pending' | 'in-progress' | 'complete' | 'escalated'
  loopCount: number
}

// ── Token usage tracking ─────────────────────────────────────────────────────

/** Accumulated API token usage for a job, updated live during execution. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  totalCostUsd: number
}

/** Snapshot of usage for a single completed phase. */
export interface PhaseUsage {
  phase: string
  /**
   * Name of the work item this phase execution was attributed to, captured
   * from `Job.currentWorkItem` at append time. Lets the dashboard reconstruct
   * per-work-item loop history without any workflow-level metadata. Undefined
   * for phases that ran before the planner registered any work items
   * (e.g. spec-writing, planning itself).
   */
  workItem?: string
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  costUsd: number
  durationMs: number
  durationApiMs: number
  numTurns: number
  model: string
  /** Per-model breakdown when multiple models were used (e.g. subagents). */
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>
}

// ── Artefact tracking ────────────────────────────────────────────────────────

/**
 * A phase output recorded by an agent for developer visibility.
 * The code layer treats `data` as opaque — only the dashboard knows how to
 * render each `kind`. Agents use `post_artifact` to append these; the
 * dashboard reads `job.artifacts` and dispatches per kind.
 */
export interface Artifact {
  id: string
  phase: string
  kind: string
  title: string
  data: Record<string, unknown>
  createdBy: string
  createdAt: string
}

// ── Insight tracking ─────────────────────────────────────────────────────────

/**
 * Target intelligence layer where an insight should ship if it becomes
 * memory. Set by the agent at `add_insight` time (`suggestedLayer`) or by
 * the user via the dashboard (`userLayer`); the evaluator falls back to
 * its own judgement when both are absent.
 */
export type InsightLayer = 'tenant' | 'repo'

/**
 * Curation state for an insight. The evaluator only ships `approved`
 * insights; `pending` (default) and `rejected` are skipped at proposal
 * time. Rejected entries are kept in the array for audit.
 */
export type InsightStatus = 'pending' | 'approved' | 'rejected'

/** A learning or workaround discovered by any agent during execution. */
export interface Insight {
  /**
   * Stable identifier assigned at `add_insight` time. Used by the
   * dashboard to address individual entries for edit / approve / reject.
   * Optional on the type only for backwards compatibility with insights
   * persisted before this field existed — readers should backfill via
   * `ensureInsightId()` on load.
   */
  id?: string
  phase: string
  category: string
  summary: string
  detail: string
  suggestion?: string
  /**
   * Set when this insight was inherited from an earlier sibling in the
   * same campaign. The dispatcher tags every insight it carries from a
   * completed child onto a freshly-dispatched sibling so the agent can
   * tell its own findings apart from upstream ones in the prompt.
   * Empty / undefined for insights produced by the current job.
   */
  sourceChildName?: string
  /**
   * Curation status. Absent on legacy records — treat as `'pending'`.
   */
  status?: InsightStatus
  /** Agent's suggested target layer at record-time. User can override. */
  suggestedLayer?: InsightLayer
  /** User-assigned target layer via dashboard. Takes precedence over suggestedLayer. */
  userLayer?: InsightLayer
  /** User-provided override for `summary`. Evaluator should prefer this if set. */
  editedSummary?: string
  /** User-provided override for `detail`. Evaluator should prefer this if set. */
  editedDetail?: string
  /** User-provided override for `suggestion`. Evaluator should prefer this if set. */
  editedSuggestion?: string
  /** Audit: who last edited the summary/detail/suggestion. */
  editedBy?: string
  editedAt?: string
  /** Audit: who last approved/rejected the insight. */
  decidedBy?: string
  decidedAt?: string
}

// ── Conversation history ─────────────────────────────────────────────────────

/**
 * One conversation turn for stateless providers that resume by replaying
 * history rather than by sessionId. Anthropic-flavoured executors leave
 * `conversationHistory` empty and round-trip via session state's `sessionId`.
 *
 * The shape is intentionally minimal — providers translate their native
 * tool-call wire formats into this normalized envelope at the executor
 * boundary so the persisted state is portable across executor plugins.
 * Lives in the wire-contract package because it is part of the persisted
 * `Job` shape; executors import it back from here.
 */
export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** Plain text content. Tool calls live in `toolCalls`/`toolResults`. */
  content: string
  /** Tool calls the assistant requested in this turn. */
  toolCalls?: ReadonlyArray<{
    id: string
    name: string
    input: unknown
  }>
  /** Tool results the runner is feeding back to the assistant. */
  toolResults?: ReadonlyArray<{
    toolCallId: string
    output: unknown
    isError?: boolean
  }>
  /** Provider-specific metadata round-tripped between turns. */
  meta?: Record<string, unknown>
}

// ── Campaign coordination ────────────────────────────────────────────────────
//
// A campaign is just a Job whose workflowPath is the campaign workflow.
// The campaign-planner registers child specs on `Job.campaignChildren[]`;
// the dispatcher's coordinator hook spawns each one as a normal Job and
// links it back via `Job.campaignParentId`. No new JobType, no new table.

/**
 * Where a campaign child issue lives in the chosen tracker.
 * Optional — children created mid-campaign without a tracker round-trip
 * still execute; the tracker is system-of-record but not on the critical
 * path. `provider` is informational; the runner picks the actual client
 * via `settings.tracker.provider`.
 */
export interface TrackerRef {
  provider: 'jira' | 'github' | 'linear'
  key: string
  url: string
}

/** Lifecycle of a single child within its campaign. */
export type CampaignChildStatus =
  | 'pending'         // registered, dependencies not yet satisfied
  | 'ready'           // dependencies satisfied, awaiting dispatcher slot
  | 'dispatched'      // child Job has been created and is running / parked
  | 'complete'        // child Job reached complete
  | 'failed'          // child Job failed
  | 'escalated'       // child Job escalated to human
  | 'skipped'         // human or evaluator skipped this child (downstream proceeds)
  | 'cancelled'       // descoped (e.g. supplanted by a re-plan); downstream proceeds, parent does not halt

/**
 * Spec for a single child of a campaign. Authored by the campaign-planner
 * via `campaign_register_child`. The dispatcher uses this as the seed for
 * a normal Job when dependencies are satisfied.
 */
export interface CampaignChild {
  /** Unique within the campaign — used as the dependsOn key. */
  name: string
  /** Free-form description handed to the child's planner. */
  description: string
  /**
   * Seed `params` for the dispatched child Job. The dispatcher merges in
   * `epicAllowed: false` and `campaignParentId: <parent>` before creation.
   */
  params: Record<string, unknown>
  /** Names of other children this one is blocked on. */
  dependsOn: string[]
  /** Tracker issue key/url, if the planner created one. */
  trackerRef?: TrackerRef
  /** Job id once dispatched. */
  jobId?: string
  status: CampaignChildStatus
  /** When the child Job was first dispatched. */
  startedAt?: string
  /** When the child Job reached a terminal status. */
  completedAt?: string
}

// ── Core Job type ─────────────────────────────────────────────────────────────

export interface Job {
  id: string
  type: JobType
  workflowPath: string

  /**
   * All job-specific parameters in a single generic bag.
   * Common keys: serviceName, repoSlug, projects, reviewers, stagingUrl,
   * description, jiraTicketId, branchName, changedFiles, prId, language
   */
  params: Record<string, unknown>

  triggerSource: 'cli' | 'jira' | 'internal'

  status: string
  phase: string
  currentWorkItem: string | null

  /** Populated by planning via set_work_items. The runner does not act on these. */
  workItems: WorkItem[]
  /** Current work-item loop count — denormalized from workItems[] for quick access. */
  workItemLoopCount: number

  prMappings: PrMapping[]

  /**
   * Interactive mode — when true, the runner parks at phase boundaries that
   * have `interactive_checkpoint: true` in the workflow YAML, waiting for
   * developer approval before advancing.
   */
  interactive: boolean

  /**
   * Artefacts posted by agents during execution (plan files, PR links, test
   * results, etc.). The code layer stores these as opaque JSON; the dashboard
   * renders them per `kind`.
   */
  artifacts: Artifact[]

  /**
   * When parked waiting for developer input at a phase boundary, this records
   * the phase the job will advance to on approval. Unset for agent-requested
   * mid-phase pauses (where the job stays on the current phase).
   */
  awaitingNextPhase?: string

  /**
   * Set by the dispatcher when a developer replies to an interactive
   * checkpoint park. Its value is the phase the developer had the option to
   * advance to (i.e., the former `awaitingNextPhase`).
   *
   * The runner consumes this on the next turn: if the agent finishes that
   * turn with the job still on the phase it was parked in, the runner skips
   * the "park for approval after {phase}" check for that one transition —
   * otherwise the job loops forever (agent calls `goto_phase` because the
   * framed prompt told it to, runner parks again because the phase still
   * has `interactive_checkpoint: true`). The field is cleared as soon as
   * the phase advances, so a subsequent natural phase end re-arms the
   * checkpoint.
   */
  approvedAdvanceFromPhase?: string

  /** Accumulated learnings from all agents. The evaluator reviews these and decides what to propose. */
  insights: Insight[]

  /** Running token usage totals — updated incrementally during execution. */
  tokenUsage: TokenUsage
  /** Per-phase usage snapshots — appended when each phase completes. */
  phaseUsage: PhaseUsage[]

  /**
   * Full ordered phase list parsed from the workflow front-matter at job
   * creation. Lets the dashboard render the entire pipeline (including
   * not-yet-started phases as ghosts) without re-parsing the workflow.
   * Optional for back-compat with older persisted jobs.
   */
  workflowPhases?: Array<{
    name: string
    status: string
    interactiveCheckpoint?: boolean
    /**
     * Owning agent for the phase, or `null` for runner-managed
     * (“agent-less”) phases such as `coordinating`. Persisted so the
     * dashboard can distinguish agent-driven phases from infrastructure
     * phases without re-parsing the workflow YAML.
     */
    agent?: string | null
  }>

  /**
   * Agent SDK session ID for this job. Used to resume conversations
   * when the job is un-parked by a webhook event.
   */
  sessionId?: string

  /**
   * Conversation replay history for executors that don't support
   * server-side session resume (e.g. OpenAI / Gemini stateless APIs).
   * Set/cleared by the executor's `done` event via its
   * `ExecutorSessionState.conversationHistory`. Anthropic-backed jobs
   * leave this `undefined` — they resume by `sessionId` alone.
   *
   * Persisted opaquely; only the executor that wrote it interprets
   * the contents on resume.
   */
  conversationHistory?: ConversationMessage[]

  createdAt: string
  updatedAt: string

  awaitingEvent?: string
  awaitingPrId?: number
  escalationMessage?: string

  /**
   * Set when the runner parks the job into {@link STATUS_AWAITING_RATE_LIMIT}
   * after the executor throws a `RateLimitExceededError`. The in-process
   * `RateLimitScheduler` re-resumes the job at `resumeAt` (epoch ms);
   * the dashboard reads the same fields to show a countdown.
   *
   * Cleared by the runner on the first successful turn after resume so a
   * subsequent rate-limit hit starts a fresh backoff sequence.
   */
  rateLimitInfo?: {
    provider: string
    kind: 'rate-limit' | 'overloaded'
    resumeAt: number
    retryAttempt: number
    source: string
    lastErrorMessage?: string
  }

  /**
   * Injected by the dispatcher when a webhook event resumes the job.
   * The runner uses this as the prompt for the resumed turn, then clears it.
   */
  pendingPrompt?: string

  /**
   * Children registered by the campaign-planner via `campaign_register_child`.
   * Present only on campaign jobs (whose workflowPath is the campaign
   * workflow). Authoritative source of dependency edges between issues.
   */
  campaignChildren?: CampaignChild[]

  /**
   * Back-pointer from a child Job to its owning campaign Job. Set by the
   * dispatcher when a campaign child is spawned. Used by webhook resolvers,
   * the dashboard, and the coordinator hook to find the parent on
   * child-stopped transitions.
   */
  campaignParentId?: string

  /**
   * Insights collected from completed campaign children, kept on the parent
   * campaign job. The dispatcher appends to this list every time a child
   * reaches a terminal status, then seeds freshly-dispatched siblings with
   * its contents (via {@link JobInput.initialInsights}) so each new child
   * inherits everything earlier siblings learned (excluding insights the
   * user marked `rejected`). Each entry has its `sourceChildName` set to
   * the originating child. The full PR-merge-pull
   * memory cycle still runs at campaign end via the campaign-evaluator —
   * this aggregator is the *in-flight* mechanism that lets sibling N+1
   * benefit from sibling N's discoveries before any human review happens.
   */
  campaignAggregatedInsights?: Insight[]

  /**
   * Audit trail of mid-job workflow switches recorded by the
   * `switch_workflow` MCP tool (and indirectly by `convert_to_campaign`,
   * which delegates to the same primitive). The current `workflowPath` is
   * always the live workflow; this list preserves the chain so the
   * dashboard, evaluator, and replay tools can reason about how the job
   * arrived in its present lane.
   */
  workflowPathHistory?: WorkflowSwitchEntry[]

  /**
   * Per-phase model overrides applied at runtime by a developer from the
   * dashboard. Keyed by phase name. When set, the runner consults this map
   * before falling through to workflow `model`/`tier` defaults — the
   * override wins because the developer is making an explicit, immediate
   * choice. Cleared by passing `clear: true` to the override endpoint.
   *
   * Each entry may optionally pin the executor `provider` so the override
   * can target a model the workflow's resolver wouldn't otherwise pick.
   * The override is purely runtime — no propose_change PR is opened
   * automatically; that flow is exposed separately via the dashboard's
   * "Save as workflow default" action.
   */
  phaseModelOverrides?: Record<string, PhaseModelOverride>
}

/**
 * One entry in {@link Job.phaseModelOverrides}. `model` carries either an
 * alias key (resolved via `settings.llm.aliases`) or a literal model id
 * (passed straight through to the executor). `provider` is optional; when
 * unset the runner picks the executor by which plugin claims to `supports`
 * the model.
 */
export interface PhaseModelOverride {
  model: string
  provider?: string
}

/**
 * One row of {@link Job.workflowPathHistory}. Recorded every time
 * `switch_workflow` mutates the job's `workflowPath`.
 */
export interface WorkflowSwitchEntry {
  at: string
  from: string
  to: string
  fromPhase: string
  toPhase: string
  reason: string
  by: 'switch_workflow' | 'convert_to_campaign'
}

// ── Job input ─────────────────────────────────────────────────────────────────

export interface JobInput {
  type?: 'job' | 'self-update'
  workflowPath?: string
  triggerSource?: 'cli' | 'jira' | 'internal'
  params: Record<string, unknown>
  /**
   * Optional seed for the new job's `insights` array. Today the only
   * caller setting this is the campaign dispatcher, which forwards the
   * parent's `campaignAggregatedInsights` so a freshly-dispatched sibling
   * can read what earlier siblings learned without waiting on the
   * campaign-evaluator's PR-merge cycle. Empty / undefined means start
   * with no insights, as before.
   */
  initialInsights?: Insight[]
}

// ── Proposals ─────────────────────────────────────────────────────────────────

// Proposal types map to specific writable file locations in the
// intelligence stack — see the `self-improvement-guide` skill in
// `@coro-ai/intelligence-base` for the canonical mapping.
//
// `source-change` was removed when the legacy `tools/src/**/*.ts`
// layout disappeared with the monorepo conversion. Runner source
// changes are out-of-band today; agents should use a regular code PR
// rather than `propose_change`.
export type ProposalType =
  | 'new-tool'
  | 'modify-tool'
  | 'new-workflow'
  | 'modify-workflow'
  | 'new-agent'
  | 'modify-agent'
  | 'memory-update'
  | 'skill-create'
  | 'skill-update'
  | 'claude-md-update'

export type ProposalStatus = 'pending' | 'approved' | 'rejected'

/**
 * Where a proposal lands.
 *   - `tenant` — the tenant intelligence repo (same mechanism for solo and team).
 *   - `repo`   — the active job's target repo, under `.coro/`.
 *   - The base layer is never writable.
 */
export type ProposalTargetLayer = 'tenant' | 'repo'

export interface ProposalFile {
  path: string
  content: string
}

export interface Proposal {
  id: string
  tenantId: string
  jobId: string
  type: ProposalType
  title: string
  rationale: string
  description: string
  status: ProposalStatus
  files: ProposalFile[]
  createdAt: string
  updatedAt: string
  reviewedBy?: string
  reviewNote?: string
  /**
   * Layer the proposal was shipped to. Optional so legacy proposals
   * predating the layered model continue to load cleanly.
   */
  targetLayer?: ProposalTargetLayer
  /** Branch name in the target repo. */
  branch?: string
  /** Web URL of the opened PR (`null` if PR opening was skipped/failed). */
  prUrl?: string | null
  /** Provider-specific PR id. */
  prId?: number | null
}

// ── Well-known workflow paths ────────────────────────────────────────────────

/**
 * Canonical path for the campaign workflow. The planner switches a job's
 * `workflowPath` to this value via `convert_to_campaign`. Tenants override
 * the workflow file itself through the layered intelligence resolver.
 */
export const CAMPAIGN_WORKFLOW_PATH = 'workflows/campaign/workflow.md'
