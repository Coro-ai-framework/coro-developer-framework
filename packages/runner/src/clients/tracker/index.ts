// ── Tracker factory ──────────────────────────────────────────────────────────
//
// Resolves a `TrackerClient` from the runtime `Settings`. The campaign-planner
// agent never picks the provider explicitly — it's a tenant-level
// configuration that defaults to whatever the install is already wired up
// for (Jira today). Future providers (GitHub Issues, Linear) plug in here
// without changing the agent prompt or the MCP tools.

import type { Settings } from '../../config/settings'
import { JiraTrackerClient } from './jira'
import { GitHubTrackerClient } from './github'
import { LinearTrackerClient } from './linear'
import type { TrackerClient, TrackerProvider } from './types'

export type { TrackerClient, TrackerProvider } from './types'
export { JiraTrackerClient } from './jira'
export { GitHubTrackerClient } from './github'
export { LinearTrackerClient } from './linear'

/**
 * Build the active TrackerClient. Provider precedence:
 *   1. Explicit `settings.tracker.provider` if set in `~/.coro/config.json`.
 *   2. Otherwise infer from whichever credentials look usable, in priority
 *      order: Jira → Linear → GitHub. The first match wins. This keeps
 *      single-tenant deployments (which historically only had Jira creds)
 *      working without a config rewrite.
 *   3. Otherwise return a "stub" Jira client that reports `available: false`
 *      from every method — agents detect this and skip tracker round-trips
 *      while still allowing the campaign workflow to proceed.
 *
 * The factory always returns a `TrackerClient` so the MCP wiring is total;
 * call `client.isAvailable()` to detect the stub case before issuing
 * dependent calls.
 */
export function createTrackerClient(settings: Settings): TrackerClient {
  const explicit = settings.tracker?.provider
  const inferred: TrackerProvider | 'none' = explicit && explicit !== 'none'
    ? explicit
    : settings.jira.baseUrl && settings.jira.apiToken
      ? 'jira'
      : settings.linear?.apiKey
        ? 'linear'
        : settings.github.token && settings.github.owner
          ? 'github'
          : 'none'

  switch (inferred) {
    case 'jira':
      return new JiraTrackerClient({
        baseUrl: settings.jira.baseUrl,
        username: settings.jira.username,
        apiToken: settings.jira.apiToken,
      })
    case 'github':
      return new GitHubTrackerClient({
        token: settings.github.token,
        defaultOwner: settings.github.owner,
        ...(settings.github.baseUrl ? { apiBaseUrl: settings.github.baseUrl } : {}),
      })
    case 'linear':
      return new LinearTrackerClient({
        apiKey: settings.linear?.apiKey ?? '',
        ...(settings.linear?.teamKey ? { defaultTeamKey: settings.linear.teamKey } : {}),
      })
    case 'none':
    default:
      // Empty Jira client: every method returns `{ available: false, ... }`.
      return new JiraTrackerClient({ baseUrl: '', username: '', apiToken: '' })
  }
}
