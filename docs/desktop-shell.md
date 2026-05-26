# Desktop Shell Contract

This document defines the Phase 1 contract for the Electron desktop shell that
will wrap the existing Coro runner and dashboard. The goal is to lock the
packaged runtime boundaries before we add the Electron package itself.

## Goals

- Keep the existing localhost architecture intact.
- Reuse the existing runner CLI entrypoint and dashboard routing.
- Keep all user data under `~/.coro` so the desktop app stays compatible with
  the CLI workflow.
- Make the future Electron main process a thin sidecar launcher rather than a
  second implementation of runner behavior.

## Runner Launch Contract

The desktop shell launches the packaged runner through a bundled Node runtime.

- Working directory: the packaged runner root under `resources/coro/runner/`
- Command: `node dist/cli/index.js start --port <port> --no-open`
- Optional config override: `--config <path>`
- Required env:
  - `CORO_NO_OPEN=1`
  - `CORO_DASHBOARD_DIST=<absolute packaged dashboard dist path>`
- Expected health URL: `http://127.0.0.1:<port>/health`
- Expected dashboard URL: `http://127.0.0.1:<port>/dashboard/`

This intentionally reuses the current runner HTTP surface instead of embedding
runner logic in Electron.

## Packaged Resource Layout

Phase 1 locks the packaged resources directory to this tree:

```text
<resources>/
└── coro/
    ├── bin/
    │   └── node
    ├── dashboard/
    │   └── dist/
    └── runner/
        ├── package.json
        ├── dist/
        └── node_modules/
```

Notes:

- `@coro-ai/intelligence-base` ships as a normal runner dependency, so its `layer/`
  assets remain inside the packaged runner dependency tree.
- The packaged runner must preserve the Claude Agent SDK's platform-specific
  optional dependency so `resolveClaudeCodeCliPath()` continues to work without a
  second desktop-specific path resolver.
- The dashboard stays external to the runner bundle and is injected through the
  existing `CORO_DASHBOARD_DIST` override.

## Port Strategy

Phase 1 chooses shell-selected port allocation.

- The Electron main process picks an available loopback port before spawning the
  runner.
- It tries port `3000` first for compatibility with current local expectations.
- If `3000` is occupied, it falls back to an ephemeral loopback port.
- The runner itself remains unchanged in Phase 1 and still receives an explicit
  `--port <port>` argument.

This avoids widening runner scope now while still making the packaged shell safe
on machines where port `3000` is already in use.

## Non-Goals For Phase 1

- No Electron package yet.
- No packaging pipeline yet.
- No updater wiring yet.
- No signing or notarization yet.
- No Windows or Linux work yet.

Phase 2 will consume this contract to build the actual Electron shell.