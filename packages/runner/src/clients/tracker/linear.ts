// ── Linear tracker client ────────────────────────────────────────────────────
//
// Implements `TrackerClient` against Linear's GraphQL API. Linear has a
// closer-to-Jira data model than GitHub Issues:
//
//   Project / Initiative      ≈ Jira Epic         (we call `projectCreate`)
//   Issue with parentId       ≈ Jira sub-task     (we call `issueCreate`)
//   IssueRelation             ≈ Jira issue link   (we call `issueRelationCreate`)
//
// Authentication uses a Linear personal API key sent verbatim in the
// `Authorization` header (no `Bearer ` prefix per Linear's docs).
//
// `projectKey` semantics for this client:
//   - On `createEpic` / `createIssue`: `projectKey` is the Linear team key
//     (e.g. `ENG`). Linear scopes issues to teams, not to projects-as-folders,
//     so the team key is the natural per-create selector. The factory
//     supplies a default team key from settings; agents may override.
//   - On `parentKey` / `key` arguments: a Linear issue identifier
//     (`ENG-123`) — the same string Linear shows in its UI.
//
// We expose the issue identifier rather than the internal UUID so the
// campaign's `TrackerRef.key` round-trips cleanly through human-readable
// markdown and tracker comments.

import type {
  CommentIssueArgs,
  CreateEpicArgs,
  CreateIssueArgs,
  LinkIssuesArgs,
  TrackerClient,
  TrackerIssue,
  TrackerNotConfigured,
  TrackerResult,
  TransitionIssueArgs,
} from './types'

export interface LinearTrackerSettings {
  apiKey: string
  /** Default Linear team key (e.g. "ENG") used when `projectKey` is empty. */
  defaultTeamKey?: string
  /** Override for the GraphQL endpoint (kept configurable for testing). */
  apiUrl?: string
}

const DEFAULT_API_URL = 'https://api.linear.app/graphql'

interface LinearIssueNode {
  id: string
  identifier: string
  title: string
  url: string
  description?: string | null
  state?: { name?: string; type?: string }
  parent?: { identifier?: string } | null
}

interface LinearTeamNode {
  id: string
  key: string
  states?: { nodes?: Array<{ id: string; name: string; type?: string }> }
}

interface LinearWorkflowState {
  id: string
  name: string
  type?: string
}

function toTrackerIssue(node: LinearIssueNode): TrackerIssue {
  return {
    key: node.identifier,
    url: node.url,
    summary: node.title,
    status: node.state?.name ?? '',
    ...(node.description?.trim() ? { description: node.description.trim() } : {}),
    ...(node.parent?.identifier ? { parentKey: node.parent.identifier } : {}),
  }
}

export class LinearTrackerClient implements TrackerClient {
  readonly provider = 'linear' as const
  private readonly available: boolean
  private readonly apiUrl: string
  private readonly teamCache = new Map<string, LinearTeamNode>()

  constructor(private readonly settings: LinearTrackerSettings) {
    this.available = settings.apiKey.length > 0
    this.apiUrl = settings.apiUrl ?? DEFAULT_API_URL
  }

  isAvailable(): boolean {
    return this.available
  }

  async createEpic(args: CreateEpicArgs): Promise<TrackerResult<TrackerIssue>> {
    if (!this.available) return this.unavailable()
    // Linear's "Project" is the closest analogue to a Jira Epic: a parent
    // container that has its own URL and groups child issues. We create
    // the Project, then mirror it as an issue so the tracker abstraction
    // — which speaks issue keys throughout — has something to return.
    const team = await this.resolveTeam(args.projectKey)
    const teamId = team.id

    const projResult = await this.gql<{ projectCreate: { success: boolean; project: { id: string; url: string; name: string } } }>(
      `mutation($input: ProjectCreateInput!) {
        projectCreate(input: $input) {
          success
          project { id url name }
        }
      }`,
      {
        input: {
          name: args.summary,
          description: args.description,
          teamIds: [teamId],
        },
      },
    )
    const project = projResult.projectCreate.project

    // Mirror the project as a tracking issue so child issues can declare
    // it as their parent and the campaign view can use a single
    // issue-shaped TrackerRef. The factory caller decides whether to
    // skip this when their workflow doesn't need a tracking issue, but
    // we do it by default for parity with the Jira/GitHub behaviour.
    const trackingIssue = await this.createIssueRaw({
      teamId,
      title: `[Epic] ${args.summary}`,
      description: `Tracks Linear project ${project.url}\n\n${args.description}`,
      labels: args.labels,
    })
    return trackingIssue
  }

  async createIssue(args: CreateIssueArgs): Promise<TrackerResult<TrackerIssue>> {
    if (!this.available) return this.unavailable()
    const team = await this.resolveTeam(args.projectKey)
    let parentId: string | undefined
    if (args.parentKey) {
      const parentNode = await this.fetchIssueNode(args.parentKey)
      parentId = parentNode.id
    }
    return this.createIssueRaw({
      teamId: team.id,
      title: args.summary,
      description: args.description,
      ...(parentId ? { parentId } : {}),
      ...(args.labels ? { labels: args.labels } : {}),
    })
  }

  async linkIssues(args: LinkIssuesArgs): Promise<TrackerResult<{ ok: true }>> {
    if (!this.available) return this.unavailable()
    const fromNode = await this.fetchIssueNode(args.fromKey)
    const toNode = await this.fetchIssueNode(args.toKey)

    // Linear relation enums are limited; map our generic relation onto the
    // closest enum value. Anything unknown falls back to `related` which is
    // safe and non-blocking.
    const lower = args.relation.toLowerCase()
    const linearType = lower.includes('block') ? 'blocks' : lower.includes('dup') ? 'duplicate' : 'related'

    await this.gql<{ issueRelationCreate: { success: boolean } }>(
      `mutation($input: IssueRelationCreateInput!) {
        issueRelationCreate(input: $input) { success }
      }`,
      { input: { issueId: fromNode.id, relatedIssueId: toNode.id, type: linearType } },
    )
    return { ok: true }
  }

  async getIssue(key: string): Promise<TrackerResult<TrackerIssue>> {
    if (!this.available) return this.unavailable()
    const node = await this.fetchIssueNode(key)
    return toTrackerIssue(node)
  }

  async searchIssues(query: string, limit = 10): Promise<TrackerResult<TrackerIssue[]>> {
    if (!this.available) return this.unavailable()
    const first = Math.min(Math.max(limit, 1), 20)
    const data = await this.gql<{
      issues: { nodes: LinearIssueNode[] }
    }>(
      `query($filter: IssueFilter, $first: Int!) {
        issues(filter: $filter, first: $first) {
          nodes { id identifier title url description state { name type } parent { identifier } }
        }
      }`,
      {
        first,
        filter: {
          or: [
            { title: { containsIgnoreCase: query } },
            { description: { containsIgnoreCase: query } },
          ],
        },
      },
    )
    return (data.issues?.nodes ?? []).map(toTrackerIssue)
  }

  async listChildren(parentKey: string): Promise<TrackerResult<TrackerIssue[]>> {
    if (!this.available) return this.unavailable()
    const data = await this.gql<{ issue: { children?: { nodes: LinearIssueNode[] } } }>(
      `query($id: String!) {
        issue(id: $id) {
          children { nodes { id identifier title url state { name type } parent { identifier } } }
        }
      }`,
      { id: parentKey },
    )
    const nodes = data.issue?.children?.nodes ?? []
    return nodes.map(toTrackerIssue)
  }

  async transitionIssue(args: TransitionIssueArgs): Promise<TrackerResult<{ ok: true }>> {
    if (!this.available) return this.unavailable()
    const node = await this.fetchIssueNode(args.key)
    const teamKey = parseTeamKey(args.key)
    const team = await this.resolveTeam(teamKey)
    const states = await this.fetchTeamStates(team.id)
    const target = pickWorkflowState(states, args.status)
    if (!target) {
      throw new Error(
        `No Linear workflow state matches "${args.status}" on team ${team.key}. ` +
          `Available: ${states.map(s => s.name).join(', ')}.`,
      )
    }
    await this.gql<{ issueUpdate: { success: boolean } }>(
      `mutation($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      { id: node.id, input: { stateId: target.id } },
    )
    return { ok: true }
  }

  async commentIssue(args: CommentIssueArgs): Promise<TrackerResult<{ ok: true }>> {
    if (!this.available) return this.unavailable()
    const node = await this.fetchIssueNode(args.key)
    await this.gql<{ commentCreate: { success: boolean } }>(
      `mutation($input: CommentCreateInput!) {
        commentCreate(input: $input) { success }
      }`,
      { input: { issueId: node.id, body: args.body } },
    )
    return { ok: true }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async createIssueRaw(args: {
    teamId: string
    title: string
    description: string
    parentId?: string
    labels?: string[]
  }): Promise<TrackerResult<TrackerIssue>> {
    const data = await this.gql<{
      issueCreate: { success: boolean; issue: LinearIssueNode }
    }>(
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier title url state { name type } parent { identifier } }
        }
      }`,
      {
        input: {
          teamId: args.teamId,
          title: args.title,
          description: args.description,
          ...(args.parentId ? { parentId: args.parentId } : {}),
          // Labels in Linear are referenced by ID, not name. Resolving by
          // name here would add a per-call round-trip; for MVP we drop
          // labels silently when the Linear client is in use. Callers can
          // still tag via `commentIssue` after creation if needed.
        },
      },
    )
    if (!data.issueCreate.success) {
      throw new Error(`Linear issueCreate returned success=false`)
    }
    return toTrackerIssue(data.issueCreate.issue)
  }

  private async fetchIssueNode(key: string): Promise<LinearIssueNode> {
    const data = await this.gql<{ issue: LinearIssueNode | null }>(
      `query($id: String!) {
        issue(id: $id) {
          id identifier title url description state { name type } parent { identifier }
        }
      }`,
      { id: key },
    )
    if (!data.issue) throw new Error(`Linear issue ${key} not found`)
    return data.issue
  }

  private async resolveTeam(teamKeyOrEmpty: string): Promise<LinearTeamNode> {
    const teamKey = teamKeyOrEmpty || this.settings.defaultTeamKey
    if (!teamKey) {
      throw new Error(
        'Linear tracker projectKey must be a team key (e.g. "ENG"); pass it explicitly or set linear.defaultTeamKey.',
      )
    }
    const cached = this.teamCache.get(teamKey)
    if (cached) return cached
    const data = await this.gql<{ teams: { nodes: LinearTeamNode[] } }>(
      `query($filter: TeamFilter) {
        teams(filter: $filter) { nodes { id key } }
      }`,
      { filter: { key: { eq: teamKey } } },
    )
    const team = data.teams.nodes[0]
    if (!team) throw new Error(`Linear team "${teamKey}" not found.`)
    this.teamCache.set(teamKey, team)
    return team
  }

  private async fetchTeamStates(teamId: string): Promise<LinearWorkflowState[]> {
    const data = await this.gql<{ team: { states?: { nodes: LinearWorkflowState[] } } }>(
      `query($id: String!) {
        team(id: $id) { states { nodes { id name type } } }
      }`,
      { id: teamId },
    )
    return data.team.states?.nodes ?? []
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: this.settings.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Linear GraphQL request failed (${res.status}): ${text}`)
    }
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
    if (body.errors && body.errors.length > 0) {
      throw new Error(`Linear GraphQL errors: ${body.errors.map(e => e.message).join('; ')}`)
    }
    if (!body.data) throw new Error('Linear GraphQL response missing data field')
    return body.data
  }

  private unavailable(): TrackerNotConfigured {
    return {
      available: false,
      reason: 'Linear tracker is not configured (apiKey missing)',
    }
  }
}

/** Extract the team prefix from a Linear identifier like "ENG-123" → "ENG". */
function parseTeamKey(identifier: string): string {
  const dash = identifier.indexOf('-')
  return dash > 0 ? identifier.slice(0, dash) : identifier
}

/**
 * Choose a workflow state on a team that matches the requested status name.
 * Linear states have both a `name` (free-form) and a `type` (one of
 * `backlog`, `unstarted`, `started`, `completed`, `canceled`, `triage`).
 * We try a name match first, then fall back to mapping common Jira-style
 * status names onto Linear types so the campaign-evaluator's "Done"
 * transition lands on the project's `completed` column.
 */
function pickWorkflowState(states: LinearWorkflowState[], status: string): LinearWorkflowState | null {
  const lower = status.toLowerCase()
  const byName = states.find(s => s.name.toLowerCase() === lower)
  if (byName) return byName

  const typeAliases: Record<string, string> = {
    'done': 'completed',
    'closed': 'completed',
    'complete': 'completed',
    'in progress': 'started',
    'in-progress': 'started',
    'in review': 'started',
    'cancelled': 'canceled',
    'canceled': 'canceled',
    'todo': 'unstarted',
    'to do': 'unstarted',
    'backlog': 'backlog',
  }
  const targetType = typeAliases[lower]
  if (!targetType) return null
  return states.find(s => s.type === targetType) ?? null
}
