# Guardrails

Guardrails are **runner-enforced policies** that block bad tool calls (for example, opening a pull request without a description or with an oversized diff). They are separate from workflow `tools:` whitelists and from guidance in agent markdown.

## Defaults

Coro ships defaults in `packages/runner/config/guardrails.defaults.json`. You do not need to copy this file into `~/.coro/config.json` — the runner loads it on every start and merges your overrides on top.

Built-in checks today:

| Rule id | When | Check | Purpose |
|---------|------|-------|---------|
| `pr-description` | `scm.create_pr` | `pr-description` | Require a minimum-length PR body with `## What` |
| `pr-diff-size` | `scm.create_pr` (coding phase) | `pr-diff-size` | Limit diff lines/files before opening a PR |
| `merge-requires-approval` | `scm.merge_pr` (review phases) | `merge-requires-approval` | Require at least one human PR approval before merge |
| `proposal-markdown-only` | `propose_change` | `proposal-markdown-only` | Self-improvement PRs may only include `.md` paths from the tool payload |

## Settings

Open **Settings → Extensions → Guardrails** in the dashboard to:

- Turn all guardrails on or off
- Enable/disable individual rules
- Tune thresholds (`minLength`, `maxLines`, `maxFiles`, …)

Changes are saved as **overrides only** in `~/.coro/config.json` under `guardrails.rules[]` (matched by rule `id`).

## Config overrides

Example `~/.coro/config.json`:

```json
{
  "guardrails": {
    "enabled": true,
    "rules": [
      { "id": "pr-diff-size", "config": { "maxLines": 1000 } },
      { "id": "pr-description", "enabled": false }
    ]
  }
}
```

## Custom script rules

When JSON is not enough, add a script rule:

1. Add to `guardrails.rules`:

```json
{
  "id": "no-friday-prs",
  "enabled": true,
  "on": "scm.create_pr",
  "check": "script",
  "script": "no-friday-prs"
}
```

2. Create `~/.coro/guardrails/no-friday-prs.mjs`:

```javascript
/** @param {import('@coro/plugin-sdk/guardrails').GuardrailContext} ctx */
export default async function (ctx) {
  if (new Date().getDay() === 5) {
    return { allow: false, reason: 'PRs are blocked on Fridays.' }
  }
  return { allow: true }
}
```

The runner loads the script on the next guardrail evaluation. Missing scripts fail closed with a clear error.

## Rule schema

| Field | Meaning |
|-------|---------|
| `id` | Stable name (used for overrides) |
| `on` | `scm.create_pr`, `scm.merge_pr`, `propose_change`, or `tool.before` |
| `check` | `pr-description`, `pr-diff-size`, `merge-requires-approval`, `proposal-markdown-only`, `script`, … |
| `config` | Check-specific options |
| `during` | Optional phase list |
| `script` | Basename for `check: script` |

## Enforcement

Guardrails run:

1. In the `scm_create_pr` and `propose_change` MCP handlers (before the SCM call / writer commit)
2. At the executor **PreToolUse** boundary (including plugin-mapped PR tools)

Agents see a denial reason and should fix the issue, then retry.
