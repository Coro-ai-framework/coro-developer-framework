# Publishing to npm

Coro publishes a **small set** of `@coro-ai/*` packages. Everything else (dashboard UI, base intelligence, cloud wire types) ships **inside `@coro-ai/runner`**.

## What users install

| Package | What it is |
|---------|------------|
| **`@coro-ai/runner`** | **`coro` CLI** + local runner + **bundled dashboard** + bundled runtime libraries |
| **`@coro-ai/llm-anthropic`** | Anthropic / Claude Code executor (optional swap-in; included by runner) |
| **`@coro-ai/llm-openai`** | OpenAI executor (optional swap-in; included by runner) |
| **`@coro-ai/plugin-sdk`** | SDK for authoring SCM / tracker / executor plugins |
| **`@coro-ai/plugin-gitlab`** | Reference GitLab SCM plugin |

Primary install path:

```bash
npm install -g @coro-ai/runner
coro start
```

That serves the dashboard at `http://localhost:3000/dashboard/` without a separate `@coro-ai/dashboard` install.

Optional extras:

```bash
coro plugin install @coro-ai/plugin-gitlab
```

## Not on npm

These are workspace-only; bundled into `@coro-ai/runner` at publish time:

- `@coro-ai/dashboard` (static `dist/` → `dashboard-dist/` in the runner tarball)
- `@coro-ai/intelligence-base` (generic agents / workflows / skills)
- `@coro-ai/cloud-protocol` (runner ↔ cloud types; plugin authors use types via `@coro-ai/plugin-sdk`)

Also not published: `@coro-ai/desktop-electron`, `@coro-ai/landing`, workspace root `coro`.

Manifest: [`scripts/publish-packages.json`](../scripts/publish-packages.json).  
Runner staging: [`scripts/prepare-runner-npm-publish.mjs`](../scripts/prepare-runner-npm-publish.mjs).

## Prerequisites

1. **npm org** — Use the [`@coro-ai`](https://www.npmjs.com/settings/coro-ai/packages) organization on npmjs.com. The publish token must belong to a user with **Read and write** on that org.
2. **GitHub secret** — `NPM_TOKEN` (automation or granular token with publish on `@coro-ai/*`).
3. **Provenance** — Workflows enable npm trusted publishing (`id-token: write`). Configure trusted publishers for this repo on npm as well.

### Troubleshooting `E404` on publish

npm returns **404** (not 401) when the token cannot create packages under the scope:

```text
npm error 404 Not Found - PUT https://registry.npmjs.org/@coro-ai%2fplugin-sdk
```

Ensure the org is **`coro-ai`** (scope `@coro-ai`), not `coro`. A token for `@coro-ai` will not publish packages still named `@coro/*`.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml):

- Builds all packages needed for release (`pnpm run build:publishable`)
- Runs runner + plugin-sdk tests
- Stages the runner bundle and runs `pnpm run verify:npm-pack`

## Releasing

### Dry run

1. Actions → **NPM Publish** → Run workflow  
2. Version e.g. `0.1.0`  
3. Leave **dry_run** enabled (default)

### Publish

Re-run with **dry_run: false**, or push tag:

```bash
git tag npm/v0.1.0
git push origin npm/v0.1.0
```

Publish order: LLM packages → plugin-sdk → plugin-gitlab → staged `@coro-ai/runner`.

### Local check

```bash
pnpm run build:publishable
pnpm run verify:npm-pack
ls .npm-pack-verify/
```

## Notes

- **`@coro-ai/runner`** depends on `@coro-ai/llm-anthropic` and `@coro-ai/llm-openai` as normal npm deps (same version as the release).
- **License** — BUSL-1.1 on all published packages.
- **Native modules** — `better-sqlite3` rebuilds on install.
