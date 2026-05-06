# @coro/plugin-sdk

Public SDK for authoring [Coro](https://github.com/coro-ai) plugins.

A Coro plugin teaches the runner how to talk to a specific source-control
provider (GitHub, BitBucket, GitLab, …) or issue tracker (Jira, Linear,
GitHub Issues, …). The runner is provider-agnostic — every per-provider
detail lives in a plugin.

## Quick start

```bash
coro plugin init my-provider
cd ~/.coro/plugins/my-provider
npm install
$EDITOR index.ts        # implement cloneInfo / matchesRemote / pollPr / normalizeInbound
coro start              # restart the runner; the plugin is detected via coro-plugin.json
```

The CLI scaffolds a directory with:

- `coro-plugin.json` — manifest read by the runner's drop-in loader.
- `package.json` — pre-wired with `@coro/plugin-sdk` as a dependency.
- `index.ts` — a stub implementing the four required hooks.
- `intelligence/` — markdown the runner copies into the per-job intelligence overlay.

## What you implement

Plugins ship under one of two contracts:

| Contract | Use when | Required hooks |
|---|---|---|
| `ScmPluginBase` | Source-control providers (PRs, branches, repo creation) | `init`, `cloneInfo`, `matchesRemote`, `pollPr` |
| `TrackerPluginBase` | Issue trackers (tickets, transitions, links) | `init` (+ either `mcpServer` OR all of `getIssue`/`commentIssue`/`transitionIssue`) |

Both bases inherit:

- `manifest: PluginManifest` — id, version, configSchema, webhook descriptor, intelligence contributions.
- Optional `mcpServer()` — when present, the runner attaches the upstream MCP server to every job session, exposing `mcp__<pluginId>__*` tools to the agent. This is the MCP-first pivot's primary outbound channel; most modern providers ship an MCP server you can point at.
- Optional `normalizeInbound(req)` — collapse provider webhook payloads into a `NormalizedEvent` so the runner can resume parked jobs.
- Optional `intelligenceRoot()` — points at a folder of markdown the resolver copies into the per-job intelligence overlay (clone-URL recipes, transition-name cheatsheets, …).

## Helpers

The SDK ships small utilities so plugin code stays focused on the integration:

- `verifyHmacSignature({ algorithm, secret, rawBody, signatureHeader })` — HMAC-verify a webhook body against the provider's signature header (handles `sha256=<hex>` / `sha1=<hex>` / raw-hex shapes).
- `mcpStdioDescriptor({ command, args, env })` — build a stdio MCP server descriptor with sensible defaults.
- `buildExternalRef({ kind, pluginId, externalId, repoKey, url })` — construct a provider-neutral pointer for PRs / tickets / repos / issues. Validates that `kind: 'pull_request'` carries a `repoKey`.
- `readHeader(headers, name)` — case-insensitive header lookup that unwraps `string[]` shapes.

## Trust model

Drop-in plugins execute in the runner's process. There is no sandbox.
Treat installation the same way you would treat installing any other npm
dependency on a server: review the source, pin the version, prefer
audited / curated registry entries.

The dashboard's "Available plugins" panel surfaces a small registry of
maintainer-reviewed packages; arbitrary npm specs require an explicit
confirmation before install.

## Running the conformance pack

The runner publishes a re-runnable conformance suite that checks
manifest invariants, lifecycle, webhook normalisation, and (for SCM
plugins) `pollPr`/`matchesRemote` consistency.

```ts
// tests/conformance.test.ts in your plugin repo
import { runConformance } from '@coro/runner/tests/plugins/conformance'
import { createMyPlugin } from '../src'

runConformance({
  id: '@vendor/coro-plugin-myprovider',
  factory: () => createMyPlugin(),
  validConfig: { /* valid config */ },
  invalidConfig: { /* missing required fields */ },
})
```

## Stability

The plugin-API host version is `1.0.0`. Plugin manifests declare
`hostCompatibility: '^1.0.0'`; the runner refuses plugins whose range
does not satisfy its host version. Breaking changes bump the host
version's major segment.
