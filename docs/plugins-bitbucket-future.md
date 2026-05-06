# BitBucket plugin — staying native, planning the MCP off-ramp

## Status
After the MCP-first plugins pivot (S1–S6 of the
`mcp-first_plugins_pivot` plan), four built-in plugins ship in MCP mode:

| Plugin | Upstream MCP server | Default `command`/`args` |
|---|---|---|
| `github` (SCM) | `@modelcontextprotocol/server-github` | `npx -y @modelcontextprotocol/server-github` |
| `github-issues` (tracker) | same as above (separate instance) | `npx -y @modelcontextprotocol/server-github` |
| `jira` (tracker) | `mcp-atlassian` (community) | `uvx mcp-atlassian` |
| `linear` (tracker) | `@linear/mcp-server` | `npx -y @linear/mcp-server` |

The `bitbucket` SCM plugin is **deliberately excluded** from this round.
It remains the single native-mode SCM plugin: its `ScmPluginRuntime`
keeps the full set of methods (`createPr`, `getPrStatus`,
`listPrComments`, `postPrComment`, `replyToComment`, `approvePr`,
`mergePr`, `createRepo`) and does **not** declare an `mcpServer()`
descriptor.

## Why we didn't migrate BitBucket

1. **No production-quality upstream MCP server exists.** As of Q2 2026
   the BitBucket MCP ecosystem is fragmented:
   - `bitbucket-mcp` (community) covers BitBucket Cloud only and lags
     several months behind the REST API.
   - The official Atlassian MCP server focuses on Jira + Confluence;
     BitBucket coverage is unannounced.
   - `bitbucket-server-mcp` covers BitBucket Server but not Cloud,
     and vice versa.
2. **BitBucket Cloud + Server share little surface.** A single MCP
   server typically targets one or the other. We'd need to ship two
   plugins (`bitbucket-cloud`, `bitbucket-server`) to use either.
3. **Coro's existing `BitBucketClient` is battle-tested and covers both
   editions.** Deleting it for an immature MCP server would be a
   regression.

## The fallback path in the hybrid proxy

The hybrid `scm_*` proxy (`packages/runner/src/mcp-handlers.ts`) checks
whether the active plugin declares `mcpServer()`. When it does, the
proxy forwards the call through the SDK's MCP client. When it
**doesn't** (BitBucket today), the proxy falls back to the plugin's
own native methods — exactly the same behaviour as before the pivot.

This means:
- BitBucket users see no change.
- GitHub / Jira / Linear / GH Issues users get the upstream MCP at
  job start; agent prompts continue to call generic `scm_*` /
  `tracker_*` tools, and Coro forwards them.

## Off-ramp options

The team's preference (as of writing) is to migrate when an upstream
server reaches feature parity. Two paths exist:

### Option A — Wait for upstream
- **Sponsor**: Atlassian (BitBucket parity in their MCP server) or a
  trusted community maintainer.
- **Trigger**: an upstream MCP server with all 8 ops (createPr,
  getPrStatus, listPrComments, postPrComment, replyToComment,
  approvePr, mergePr, createRepo) for both Cloud and Server.
- **Migration**: identical shape to the `github` plugin — delete
  the `BitBucketClient`-backed methods, add `mcpServer()` returning
  the upstream descriptor, keep `cloneInfo`/`matchesRemote`/
  `normalizeInbound`/`pollPr` (with `pollPr` keeping the inline
  fetch for the same reasons GitHub's does).
- **Effort**: ~half a day (the github migration was a template).

### Option B — Publish our own
- **Build**: extract `BitBucketClient` into a standalone
  `@coro/mcp-server-bitbucket` npm package implementing the MCP
  server protocol against our existing client.
- **Publish**: under `@coro/`, pinned alongside the runner's release
  cadence so version drift is impossible.
- **Migrate**: BitBucket plugin's `mcpServer()` returns
  `{ command: 'npx', args: ['-y', '@coro/mcp-server-bitbucket'], env: { … } }`.
- **Pro**: full control of feature surface, no upstream churn.
- **Con**: maintenance cost — same surface area we already maintain,
  just exposed as an MCP server.
- **Effort**: ~3-5 days first time, low ongoing.

### Option C — Contribute upstream
- **Pick** the most-active community BitBucket MCP repo (currently
  `aashari/mcp-server-atlassian-bitbucket` — covers Cloud).
- **Contribute** missing operations and a Server transport.
- **Use** the upstream server once merged.
- **Pro**: ecosystem benefit, smaller maintenance burden over time.
- **Con**: PR review timelines, dependence on upstream maintainers.
- **Effort**: ~1-2 weeks of focused contribution work.

## Decision criteria

Pick **A** if upstream lands a complete server within ~3 months.
Otherwise default to **B**: own the BitBucket MCP server. **C** is the
nice-to-have only when (a) we have spare capacity and (b) an upstream
has clear momentum.

## What changes in the codebase when we migrate

- Add `mcpServer()` to `BitBucketScmPlugin`.
- Drop `createPr`/`getPrStatus`/etc. from the runtime (mirrors the
  GitHub migration).
- The hybrid proxy in `mcp-handlers.ts` already checks for
  `mcpServer()`; once present, the BitBucket-specific fallback path
  becomes dead code and can be removed in the same PR.
- The legacy `bb_*` MCP shims (already in their stage-N+1
  deprecation cycle per `plugins/deprecation.ts`) can be deleted
  outright with this migration.
- BitBucket's intelligence snippet
  (`packages/runner/src/plugins/builtin/bitbucket/intelligence/snippets/bitbucket-clone.md`)
  gets a "Two ways to call BitBucket" header section, mirroring
  the GitHub one.

## Tracking
File a tracker issue with the title "BitBucket plugin: migrate to
MCP mode" and link this doc when picking option A / B / C.
