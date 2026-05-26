# Publishing to npm

Coro publishes a **small set** of `@coro/*` packages. Everything else (dashboard UI, base intelligence, cloud wire types) ships **inside `@coro/runner`**.

## What users install

| Package | What it is |
|---------|------------|
| **`@coro/runner`** | **`coro` CLI** + local runner + **bundled dashboard** + bundled runtime libraries |
| **`@coro/llm-anthropic`** | Anthropic / Claude Code executor (optional swap-in; included by runner) |
| **`@coro/llm-openai`** | OpenAI executor (optional swap-in; included by runner) |
| **`@coro/plugin-sdk`** | SDK for authoring SCM / tracker / executor plugins |
| **`@coro/plugin-gitlab`** | Reference GitLab SCM plugin |

Primary install path:

```bash
npm install -g @coro/runner
coro start
```

That serves the dashboard at `http://localhost:3000/dashboard/` without a separate `@coro/dashboard` install.

Optional extras:

```bash
coro plugin install @coro/plugin-gitlab
```

## Not on npm

These are workspace-only; bundled into `@coro/runner` at publish time:

- `@coro/dashboard` (static `dist/` → `dashboard-dist/` in the runner tarball)
- `@coro/intelligence-base` (generic agents / workflows / skills)
- `@coro/cloud-protocol` (runner ↔ cloud types; plugin authors use types via `@coro/plugin-sdk`)

Also not published: `@coro/desktop-electron`, `@coro/landing`, workspace root `coro`.

Manifest: [`scripts/publish-packages.json`](../scripts/publish-packages.json).  
Runner staging: [`scripts/prepare-runner-npm-publish.mjs`](../scripts/prepare-runner-npm-publish.mjs).

## Prerequisites

1. **npm org** — Create [`@coro`](https://www.npmjs.com/org/create) and grant publish access.
2. **GitHub secret** — `NPM_TOKEN` (automation token with publish on `@coro/*`).
3. **Provenance** — Workflows enable npm trusted publishing (`id-token: write`).

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

Publish order: LLM packages → plugin-sdk → plugin-gitlab → staged `@coro/runner`.

### Local check

```bash
pnpm run build:publishable
pnpm run verify:npm-pack
ls .npm-pack-verify/
```

## Notes

- **`@coro/runner`** depends on `@coro/llm-anthropic` and `@coro/llm-openai` as normal npm deps (same version as the release).
- **License** — BUSL-1.1 on all published packages.
- **Native modules** — `better-sqlite3` rebuilds on install.
