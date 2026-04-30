// ── Tracker factory ──────────────────────────────────────────────────────────
//
// Resolves a `TrackerClient` from the runtime `Settings`. The campaign-planner
// agent never picks the provider explicitly — it's a tenant-level
// configuration that defaults to whatever the install is already wired up
// for (Jira today). Future providers (GitHub Issues, Linear) plug in here
// without changing the agent prompt or the MCP tools.

import type { Settings } from '../../config/settings'
import { JiraTrackerClient } from './jira'
import type { TrackerClient, TrackerProvider } from './types'

export type { TrackerClient } from './types'
export { JiraTrackerClient } from './jira'

/**
 * Build the active TrackerClient. Provider precedence:
 *   1. Explicit `settings.tracker.provider` if set in `~/.coro/config.json`.
 *   2. Fall back to Jira whenever Jira credentials look usable. This keeps
 *      existing single-tenant deployments working without a config rewrite.
 *   3. Otherwise return a "stub" Jira client that reports `available: false`
 *      from every method — agents detect this and skip tracker round-trips
 *      while still allowing the campaign workflow to proceed.
 *
 * The factory always returns a `TrackerClient` so the MCP wiring is total;
 * call `client.isAvailable()` to detect the stub case before issuing
 * dependent calls.
 */
export function createTrackerClient(settings: Settings): TrackerClient {
  const explicit = (settings as Settings & { tracker?: { provider?: TrackerProvider | 'none' } }).tracker?.provider
  const inferred: TrackerProvider | 'none' = explicit
    ?? (settings.jira.baseUrl && settings.jira.apiToken ? 'jira' : 'none')

  switch (inferred) {
    case 'jira':
      return new JiraTrackerClient({
        baseUrl: settings.jira.baseUrl,
        username: settings.jira.username,
        apiToken: settings.jira.apiToken,
      })
    case 'github':
    case 'linear':
      // Stub for post-MVP. Returning a Jira client with empty creds keeps
      // the surface usable (`available=false`) without conditional wiring
      // upstream; replacing this branch is the only change needed when the
      // GitHub Issues / Linear clients land.
      return new JiraTrackerClient({ baseUrl: '', username: '', apiToken: '' })
    case 'none':
    default:
      return new JiraTrackerClient({ baseUrl: '', username: '', apiToken: '' })
  }
}
