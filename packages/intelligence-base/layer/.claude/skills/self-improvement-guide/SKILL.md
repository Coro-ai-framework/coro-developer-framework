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
3. **Materialise** — the runner resolves the writable source clone for that layer and constructs the final file contents there. This is intentionally separate from the resolver's `_intelligence` tree: `_intelligence` is a read-only, multi-layer view and must never be used as the source of truth for proposal writes.
4. **Commit** — every file in your `files: []` payload, in one atomic commit.
5. **Push** + **open PR** via whichever SCM plugin is active for the layer (GitHub, Bitbucket, GitLab, …).
6. **Record** in the state backend — surfaces in `list_proposals` and the dashboard.
7. **Return** the PR URL. A human reviews and merges; the next job's resolver pulls the merged change automatically.

If validation fails, the tool throws — **no commit, no push, no PR**. Fix the input and retry.

## How to file a proposal (Evaluator and PR Reviewer)

**Bundle every file change for a layer into one call.** The runner enforces this: a second `propose_change` for the same `(jobId, layer)` is rejected with a structured error citing the prior proposal's branch and PR URL. Prefer one call per layer per job; in the rare case where you need both, that is at most two calls per job (one tenant, one repo).

### Memory entries: prefer the structured `entries[]` schema

Memory grows monotonically and is loaded by every future job. Brevity wins. The runner exposes a structured schema that **renders** entries into the canonical short-form layout and **rejects** entries that exceed the per-kind line budget.

For `memory-update`, append-only memory files (`memory/*.md` and `.coro/memory/*.md`, excluding `memory/MEMORY.md`) are merged against the current file in the writable tenant/repo source clone. That means you can send a short snippet or structured `entries[]` block and the runner will preserve the existing file contents in the PR branch. `memory/MEMORY.md` is the deliberate exception: treat it as an explicitly authored index file.

```
propose_change({
  type: "memory-update",
  title: "Capture cgo build failure on macOS arm64",
  rationale: "Recurring failure; cheap recipe to dodge it.",
  description: "Adds one short pitfall.",
  entries: [
    {
      file: "memory/known-pitfalls.md",
      kind: "pitfall",
      title: "cgo build fails on macOS arm64 inside the runner sandbox",
      symptom: "go build ./... exits with `ld: framework not found CoreFoundation`",
      rootCause: "CGO_ENABLED is on but the sandbox lacks the macOS SDK headers",
      recipe: "export CGO_ENABLED=0\\ngo build ./..."
    }
  ]
})
```

Length budgets the runner mechanically enforces:

| Kind                         | Max lines | Required fields                                                  |
|------------------------------|-----------|------------------------------------------------------------------|
| `pitfall`                    | **8**     | `title`, `symptom`, `rootCause`, `recipe` (≤ 4 lines, copy-paste only) |
| `pattern`                    | **10**    | `title`, `whenToUse`, `recipe` (≤ 6 lines), `antiPattern`        |
| Skill section (`skill-update`) | **15**    | per added `##` section in any SKILL.md you touch                 |

If a finding wants to exceed these budgets it is **either two findings or already documented** — split or dedupe. Background storytelling, full reproductions, and speculative "consider also …" text belong in the evaluation report, not in memory.

### Mixed bundles still work

For non-memory changes, or when you need to ship a memory entry alongside other intelligence in the same layer, use `files: []`:

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

You can also combine `entries[]` and `files[]` in the same call — `entries[]` is the recommended shape for new memory additions, `files[]` for skill / agent / workflow changes.

### Pre-flight dedupe (mandatory)

Before composing anything:

1. Call `list_proposals({ status: "pending" })` to check for in-flight PRs that already cover the same ground.
2. Scan `memory/MEMORY.md` and the relevant memory files for the same symptom keyword.

Near-duplicates ⇒ **skip** or **append a one-line cross-reference** to the existing entry; do not author a new section.

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
