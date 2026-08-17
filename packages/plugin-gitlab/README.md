# `@coro-ai/plugin-gitlab`

Reference Coro plugin for GitLab. Operates in **MCP mode**: day-to-day
SCM operations (creating MRs, posting comments, merging) are served by
the upstream
[`@modelcontextprotocol/server-gitlab`](https://www.npmjs.com/package/@modelcontextprotocol/server-gitlab)
package which Coro spawns once per job. The plugin itself only owns
the four operations that have no MCP equivalent:

- `cloneInfo` — clean HTTPS clone URL plus username/password
- `matchesRemote` — host detection for self-improvement PRs
- `normalizeInbound` — webhook → `NormalizedEvent`
- `pollPr` — REST polling outside `query()` sessions
- `writerCreatePr` — escape hatch used by the self-improvement writer

It is published as a working example for plugin authors. The same
shape is used by every published Coro plugin.

## Install

```bash
coro plugin install @coro-ai/plugin-gitlab
```

Then configure under `plugins.installed.gitlab` in `~/.coro/config.json`:

```json
{
  "plugins": {
    "installed": {
      "gitlab": {
        "enabled": true,
        "config": {
          "namespace": "my-group",
          "token": "glpat-…",
          "baseUrl": "https://gitlab.example.com/api/v4"
        }
      }
    }
  }
}
```

`baseUrl` is optional — omit for `gitlab.com`. The token needs the
`api` and `read_repository` scopes.

Restart `coro start` so the runner picks up the new plugin.

## Architecture

```
agent ──► mcp__gitlab__create_merge_request   ─┐
agent ──► scm_create_pr (proxy)               ─┤── upstream MCP server
                                                │   (npx @modelcontextprotocol/server-gitlab)
runner   normalizeInbound (webhook bridge)
runner   pollPr             (timer poller)      ── direct REST
runner   writerCreatePr     (writer)            ── direct REST
runner   cloneInfo          (clone helper)      ── pure local
```

The agent always prefers the trimmed `scm_*` proxy or the direct
`mcp__gitlab__*` tools. The plugin's REST calls are reserved for
operations that run outside any active `query()` session.

## License

BUSL-1.1 — published as a reference implementation. Pin to a
specific version when shipping in production.
