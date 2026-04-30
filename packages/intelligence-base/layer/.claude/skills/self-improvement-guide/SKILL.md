---
name: self-improvement-guide
description: >-
  Guide for proposing improvements to the Coro agent intelligence stack. Describes
  the file structure, skill format, proposal types, target layers, and how
  `propose_change` opens a PR. Read this before calling `propose_change` or
  deciding what type of improvement to propose.
---

# Self-Improvement Guide

## Intelligence file locations (single source of truth)

| Location | Purpose | How loaded |
|----------|---------|------------|
| `.claude/CLAUDE.md` | Behavior rules, company context, git conventions, infrastructure | Always — SDK native via `settingSources: ['project']` |
| `.claude/skills/*/SKILL.md` | Domain knowledge, language conventions, guides | On-demand — agent invokes the Skill tool |
| `memory/MEMORY.md` + linked files | Accumulated knowledge from past jobs | Always — builder injects |
| `agents/*.md` | Phase-specific agent procedures | Per-phase — builder injects |
| `workflows/*/workflow.md` | Workflow lifecycle definitions | Per-job-type — builder injects |

## Layered intelligence: where do changes land?

Coro stacks intelligence in three layers. Each layer has different write rules:

| Layer | Source of truth | Writable? | When it applies |
|-------|-----------------|-----------|-----------------|
| `base` | `@coro/intelligence-base` (ships with the runner) | **No** — never | Always; product-level conventions |
| `tenant` | `tenant.overlay.gitRemote.url` (configured per solo dev or team) | **Yes** | Solo & team — your durable, cross-repo learnings |
| `repo` | The active job's target repo, under `.coro/` | **Yes** | This repo only — project-specific conventions |

Solo and team are identical here: a solo developer points the tenant overlay at their personal `coro-intelligence` git repo; a team points it at a shared one. The mechanism is the same.

## Choosing the target layer

`propose_change` decides automatically by **path prefix** (default routing):

- Path starts with `.coro/...` → **repo** layer (PR against the project repo)
- Anything else → **tenant** layer (PR against the tenant intelligence repo)

You can also pass `targetLayer: 'tenant' | 'repo'` explicitly; the tool validates the explicit choice agrees with the path. **Base is never writable** — proposals to `@coro/intelligence-base/layer/...` are rejected.

| Goal | Use the … layer | Path |
|------|-----------------|------|
| Pattern that applies across all repos in your tenant | tenant | `memory/...`, `.claude/skills/...`, `agents/...`, `workflows/...` |
| Convention specific to one project | repo | `.coro/memory/...`, `.coro/agents/...`, etc. |

## Proposal type reference

| Type | Target file pattern | When to use |
|------|---------------------|-------------|
| `memory-update` | `memory/*.md` (tenant) or `.coro/memory/*.md` (repo) | Reusable pattern, pitfall, or workaround |
| `skill-create` | `.claude/skills/{new-name}/SKILL.md` | New domain that needs a guide |
| `skill-update` | `.claude/skills/{name}/SKILL.md` | Gap in existing domain knowledge or convention |
| `claude-md-update` | `.claude/CLAUDE.md` | Missing behavior rule, company context change |
| `new-agent` / `modify-agent` | `agents/{name}.md` | Add or fix an agent procedure |
| `new-workflow` / `modify-workflow` | `workflows/{type}/workflow.md` | Phase ordering or model selection change |
| `new-tool` / `modify-tool` | Multiple files (skill + tests + docs) | New or improved domain capability |

## How `propose_change` ships a change

Each call is **synchronous** and produces exactly **one PR**:

1. **Validate** — path is in the writable allowlist for the inferred layer; per-type format checks (skill frontmatter, agent headings, etc.).
2. **Branch** — `coro/proposal/<jobId>-<layer>-<slug>` cut from the layer's default branch.
3. **Commit** — every file in your `files: []` payload, in one atomic commit.
4. **Push** + **open PR** via the configured git provider (GitHub or Bitbucket).
5. **Record** in the state backend — surfaces in `list_proposals` and the dashboard.
6. **Return** the PR URL. A human reviews and merges; the next job's resolver pulls the merged change automatically.

If validation fails, the tool throws — **no commit, no push, no PR**. Fix the input and retry.

## How to file a proposal (Evaluator and PR Reviewer)

**Bundle every file change for a layer into one call.** Calling `propose_change` twice for the same layer in one job opens two PRs — duplicate review work and harder-to-merge diffs. Prefer one call per layer per job; in the rare case where you need both, that is at most two calls per job (one tenant, one repo).

```
propose_change({
  type: "memory-update",
  title: "Capture API quirk + add skill update",
  rationale: "We hit this twice in two days; reusable across repos.",
  description: "Append to known-pitfalls.md AND tighten the http-client skill.",
  files: [
    { path: "memory/known-pitfalls.md", content: "..." },
    { path: ".claude/skills/http-client/SKILL.md", content: "..." }
  ]
  // targetLayer omitted — both files route to tenant via path prefix
})
```

Before proposing, call `list_proposals({ status: "pending" })` to check for an in-flight PR that already covers the same ground.

## Skill file format

Each skill lives in `.claude/skills/{name}/SKILL.md` with YAML frontmatter:

- `name` — max 64 chars, lowercase letters/numbers/hyphens only.
- `description` — non-empty; describes WHAT the skill does and WHEN to invoke it.

The tool validates frontmatter inline before touching git. Missing or malformed frontmatter results in an immediate error so you can fix it and retry.

## Things that no longer exist

- `knowledge/` directory — migrated to `.claude/skills/`.
- `conventions/` directory — `git.md` absorbed into `.claude/CLAUDE.md`; language conventions migrated to `.claude/skills/`.
- Proposal types `convention-change` and `knowledge-update` — use `skill-update` instead.
- Proposal type `source-change` — runner source changes are out-of-band; open a regular code PR.
- The on-disk `memory/proposals/` summary — proposals live in the state backend now and surface via `list_proposals` and the dashboard.
- The file watcher — `propose_change` opens the PR synchronously; there is no polling step.
