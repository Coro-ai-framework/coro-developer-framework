# Contributing to Coro

Thank you for your interest in Coro. This document covers setup, scope, and how we
review changes.

## Before you start

- Read [NOTICE.md](NOTICE.md) for the open-core license split.
- Sign the [Contributor License Agreement](CLA.md) via
  [CLA Assistant](https://cla-assistant.io/Coro-ai-framework/coro-developer-framework)
  (required before we can merge your PR; one-time per GitHub account).
- For security issues, do **not** open a public issue — see [SECURITY.md](SECURITY.md).

## Development environment

**Requirements:** Node.js ≥ 20, pnpm ≥ 9.

```bash
git clone https://github.com/Coro-ai-framework/coro-developer-framework.git
cd coro-developer-framework
pnpm install
pnpm build
pnpm test
```

Run the runner locally:

```bash
pnpm dev:runner
# or
pnpm --filter @coro/runner dev
```

See [docs/local-setup.md](docs/local-setup.md) for credentials, intelligence overlays,
and hybrid/cloud configuration.

## Project layout

| Package | Role |
|---------|------|
| `packages/runner` | CLI, job engine, MCP tools, state backends |
| `packages/dashboard` | Web UI |
| `packages/intelligence-base` | Base agents, workflows, skills |
| `packages/plugin-sdk` | Plugin author SDK |
| `packages/runner/src/cloud` | **Commercial** — not accepting drive-by refactors without discussion |

## What belongs in a PR

**In scope**

- Bug fixes and tests
- Runner, dashboard, intelligence-base, plugin-sdk improvements
- New or updated plugins (see `packages/plugin-gitlab` as a reference)
- Documentation that helps contributors and operators

**Discuss first (issue or Discussion)**

- Large architectural changes
- New workflow phases or agent roles
- Changes to merge semantics for intelligence layers
- Anything under `packages/runner/src/cloud/` (commercial surface)

**Out of scope**

- Changes that require secrets in CI for every fork (mock or gate behind labels instead)
- One-off features for a single tenant (prefer a plugin or repo overlay)
- GPL/AGPL dependencies (see license check below)

## Code style

- TypeScript strict mode; match existing patterns in the file you edit.
- Run `pnpm typecheck` and `pnpm test` before opening a PR.
- Prefer focused PRs; link related issues.

## SPDX license headers

New and substantially modified source files should include:

```typescript
// SPDX-License-Identifier: BUSL-1.1
```

Files under `packages/runner/src/cloud/`:

```typescript
// SPDX-License-Identifier: LicenseRef-Coro-Commercial-1.0
```

## Pull request checklist

- [ ] CLA signed
- [ ] Tests added or updated where behavior changed
- [ ] `pnpm test` and `pnpm typecheck` pass locally
- [ ] Docs updated if user-facing behavior changed
- [ ] No secrets, real customer names, or private URLs in commits

## Large changes (RFC)

For changes that touch multiple packages, alter workflow contracts, or change
intelligence merge rules, open a GitHub Discussion or issue first with:

- Problem statement
- Proposed approach
- Alternatives considered
- Migration / rollout notes

Wait for maintainer feedback before investing in a large implementation.

## Community

Be respectful and constructive. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
