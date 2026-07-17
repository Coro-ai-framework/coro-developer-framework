// ── Tracker client shared types ──────────────────────────────────────────────
//
// Argument / result envelopes shared by every concrete tracker REST client
// (`JiraTrackerClient`, `LinearTrackerClient`, `GitHubTrackerClient`). The
// clients themselves are owned by their corresponding plugin runtimes and
// resolved through `PluginRegistry.resolveTracker({})`; the runner core no
// longer mounts an aggregated `TrackerClient` interface — every tracker
// path goes through the registry.

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
  /** Issue body / description when available. */
  description?: string
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
  /**
   * When set, post as a threaded reply to this comment id. Supported by
   * Jira (Software/Business) and Linear; ignored by flat providers.
   */
  parentId?: string
}

/** One comment on a tracker issue. Mirrors the plugin contract's `TrackerComment`. */
export interface TrackerComment {
  /** Provider-native comment id. */
  id: string
  /** Comment body as plain text / markdown. */
  body: string
  /** Author display name / handle, when available. */
  author?: string
  /** ISO-8601 creation timestamp. */
  createdAt: string
  /** ISO-8601 last-edit timestamp, when distinct from createdAt. */
  updatedAt?: string
  /** Deep link to the comment, when available. */
  url?: string
  /**
   * Id of the comment this one replies to, on providers with a threaded
   * comment model (Jira Software/Business, Linear). Absent on top-level
   * comments and flat providers (GitHub Issues).
   */
  parentId?: string
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
