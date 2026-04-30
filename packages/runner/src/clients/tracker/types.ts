// ── Tracker abstraction ──────────────────────────────────────────────────────
//
// Issue trackers (Jira, GitHub Issues, Linear, …) are write-back targets the
// campaign-planner uses to record the breakdown of a feature into reviewable
// issues with explicit dependency edges. The runner stays provider-agnostic
// by talking to this interface only; concrete clients live alongside in
// `clients/tracker/<provider>.ts`.
//
// Why a separate abstraction over the existing `JiraClient`:
//   - JiraClient today is read-skewed (get / search / comment / transition).
//     The campaign workflow needs create + link + list-children, which are
//     write operations; lumping them into JiraClient would muddy the
//     existing readonly contract used by the spec-writer agent.
//   - GitHub Issues and Linear use entirely different shapes. A common
//     interface keeps the campaign-planner agent prompt portable across
//     tenants without per-provider branches in agent markdown.

export type TrackerProvider = 'jira' | 'github' | 'linear'

export interface TrackerIssue {
  /** Provider-native key, e.g. `PROJ-123` (Jira), `42` (GitHub), `ENG-7` (Linear). */
  key: string
  /** Web URL to the issue. */
  url: string
  /** One-line summary / title of the issue. */
  summary: string
  /** Provider-native status name, e.g. "To Do", "In Progress", "Done". */
  status: string
  /** Issuetype name where applicable (Jira: Story/Task/Epic). */
  issueType?: string
  /** Parent issue key, where the provider exposes one (e.g. epic key on Jira). */
  parentKey?: string
}

export interface CreateIssueArgs {
  /** Project key (Jira) / repo (GitHub Issues) / team (Linear). Provider-specific. */
  projectKey: string
  summary: string
  description: string
  /** Optional issue type name. Defaults vary by provider (Jira: Task, GitHub: nothing, Linear: nothing). */
  issueType?: string
  /** Optional parent epic / parent issue key. */
  parentKey?: string
  /** Optional pre-applied labels. */
  labels?: string[]
}

export interface CreateEpicArgs {
  projectKey: string
  summary: string
  description: string
  labels?: string[]
}

export interface LinkIssuesArgs {
  /** Source side of the relation (e.g. the dependent issue). */
  fromKey: string
  /** Target side of the relation (e.g. the issue that must complete first). */
  toKey: string
  /**
   * Provider-native relation name. The campaign-planner uses 'Blocks' to mean
   * "fromKey is blocked by toKey" (matching the dispatcher's dependsOn
   * semantics). Other tracker-specific relations pass through verbatim.
   */
  relation: 'Blocks' | 'Relates' | string
}

export interface TransitionIssueArgs {
  key: string
  /** Provider-native target status name (e.g. "In Progress", "Done"). */
  status: string
}

export interface CommentIssueArgs {
  key: string
  body: string
}

/**
 * Common error envelope returned by every tracker method. We do NOT throw on
 * "tracker not configured" — agents should be able to detect missing config
 * and fall through to a no-op rather than abort the whole campaign-planning
 * phase. Hard errors (auth failure, API outage) still throw via fetch.
 */
export interface TrackerNotConfigured {
  available: false
  reason: string
}

export type TrackerResult<T> = T | TrackerNotConfigured

export interface TrackerClient {
  readonly provider: TrackerProvider
  /** Always usable as a probe — agents can read this before committing to a tracker round-trip. */
  isAvailable(): boolean

  createEpic(args: CreateEpicArgs): Promise<TrackerResult<TrackerIssue>>
  createIssue(args: CreateIssueArgs): Promise<TrackerResult<TrackerIssue>>
  linkIssues(args: LinkIssuesArgs): Promise<TrackerResult<{ ok: true }>>
  getIssue(key: string): Promise<TrackerResult<TrackerIssue>>
  listChildren(parentKey: string): Promise<TrackerResult<TrackerIssue[]>>
  transitionIssue(args: TransitionIssueArgs): Promise<TrackerResult<{ ok: true }>>
  commentIssue(args: CommentIssueArgs): Promise<TrackerResult<{ ok: true }>>
}
