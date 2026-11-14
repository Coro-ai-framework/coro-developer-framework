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

Also not published: `@coro-ai/desktop-electron`, workspace root `coro`.

Manifest: [`scripts/publish-packages.json`](../scripts/publish-packages.json).  
Runner staging: [`scripts/prepare-runner-npm-publish.mjs`](../scripts/prepare-runner-npm-publish.mjs).

CI copies the staged tree to `artifacts/runner-npm-staging/` before `upload-artifact`
because `upload-artifact@v4` does not upload paths ignored by `.gitignore`
(`packages/runner/.npm-publish/`).

## Prerequisites

1. **npm org** — Use the [`@coro-ai`](https://www.npmjs.com/settings/coro-ai/packages) organization on npmjs.com. The token owner must have publish access to the packages.
2. **GitHub secret** — `NPM_TOKEN` must be a valid granular token with **Read and write (publish and stage)** access to the packages or scope. Enable bypass 2FA for publishing if required by the account or packages.
3. **Provenance** — The workflow enables signed provenance (`id-token: write`); this does not authenticate the npm token.

### Troubleshooting `E404` on publish

npm can return **404** on publish when authentication or package permissions are
wrong, even for an existing package:

```text
npm error 404 Not Found - PUT https://registry.npmjs.org/@coro-ai%2fplugin-sdk
```

Check the **Verify npm credentials** step first. If `npm whoami` returns 401,
replace the expired, revoked, or otherwise invalid `NPM_TOKEN` GitHub secret.
If authentication succeeds, check the token's package permissions and its
owner's access to the `@coro-ai` packages. Organization-management permissions
alone do not grant package publishing access. A signed provenance statement
does not mean the package was successfully published.

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
- **Bundled `node_modules`** — The runner publish tarball sets `bundleDependencies: true` so `npm pack` includes the full production `node_modules` tree (see `prepare-runner-npm-publish.mjs`). npm ignores `node_modules` in `files` unless dependencies are bundled; a partial `bundledDependencies` list omits direct deps like `pino`/`express`, which breaks `npm install -g` (`Cannot find module 'pino'` when running `coro start`).

### Troubleshooting `Cannot find module 'pino'` after `npm install -g`

You are on a runner release published **before** the vendored-`node_modules` fix. Either upgrade to a newer `@coro-ai/runner` once republished, or work around on the broken version:

```bash
cd "$(npm root -g)/@coro-ai/runner" && npm install --omit=dev
```
