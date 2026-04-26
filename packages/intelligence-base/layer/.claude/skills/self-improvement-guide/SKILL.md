---
name: self-improvement-guide
description: >-
  Guide for proposing improvements to the Coro agent intelligence stack. Describes
  the file structure, skill format, proposal types, and validation rules. Read this
  before calling propose_change or deciding what type of improvement to propose.
---

# Self-Improvement Guide

## Intelligence file locations (single source of truth)

| Location | Purpose | How loaded |
|----------|---------|------------|
| `.claude/CLAUDE.md` | Behavior rules, company context, git conventions, infrastructure | Always — SDK native via settingSources |
| `.claude/skills/*/SKILL.md` | Domain knowledge, language conventions, guides | On-demand — agent invokes Skill tool |
| `memory/MEMORY.md` + linked files | Accumulated knowledge from past jobs | Always — builder injects |
| `agents/*.md` | Phase-specific agent procedures | Per-phase — builder injects |
| `workflows/*/workflow.md` | Workflow lifecycle definitions | Per-job-type — builder injects |

## Proposal type reference

| Type | Target location | When to use |
|------|-----------------|-------------|
| `memory-update` | `memory/known-pitfalls.md`, `memory/successful-patterns.md`, etc. | Reusable pattern, pitfall, or workaround |
| `skill-create` | `.claude/skills/{new-name}/SKILL.md` | New domain that needs a guide |
| `skill-update` | `.claude/skills/{name}/SKILL.md` | Gap in existing domain knowledge or convention |
| `claude-md-update` | `.claude/CLAUDE.md` | Missing behavior rule, company context change |
| `modify-agent` | `agents/{name}.md` | Agent procedure fix |
| `modify-workflow` | `workflows/{type}/workflow.md` | Phase ordering, model selection change |
| `source-change` | `tools/src/**/*.ts` | Coro Runner infrastructure fix |

## Skill file format

Each skill lives in `.claude/skills/{name}/SKILL.md` with YAML frontmatter:

- `name`: max 64 chars, lowercase letters/numbers/hyphens only
- `description`: non-empty, describes WHAT the skill does and WHEN to invoke it

Validation: the watcher checks frontmatter before opening a PR. Missing or malformed
frontmatter causes a validation failure written to `memory/proposals/`.

## Things that no longer exist

- `knowledge/` directory — migrated to `.claude/skills/` (e.g., `feature-planning`, `feature-testing`)
- `conventions/` directory — `git.md` absorbed into `.claude/CLAUDE.md`; `golang.md` and `dotnet.md` migrated to `.claude/skills/`
- ProposalTypes `convention-change` and `knowledge-update` — use `skill-update` instead
