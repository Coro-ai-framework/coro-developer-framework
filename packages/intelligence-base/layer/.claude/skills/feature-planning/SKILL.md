---
name: feature-planning
description: >-
  Implementation planning: spec analysis, work-item breakdown, implementation
  plan format, language detection, branch strategy. Use when planning generic
  implementation jobs in existing services.
---

# Implementation Planning Guide

Domain-specific guidance for planning generic implementation jobs in existing services. Supplements the generic Planner agent instructions with scoping and sequencing conventions for code changes that may span one or more work items.

## Scoping from a spec or description

When planning an implementation job:

1. **Understand the request:** Read the job spec or description thoroughly. Identify the specific behavior changes, new endpoints, UI changes, backend logic, or fixes required.
2. **Identify affected files:** Map which files in the existing codebase need to be modified or created.
3. **Assess scope:** Break the work into logical work items if the change is large enough to warrant multiple PRs. For small changes, a single work item/PR is fine.
4. **Check dependencies:** Identify if any existing code needs to be refactored first, or if new dependencies need to be added.

## Work-item breakdown rules

- Each work item should be a self-contained, mergeable unit of work
- Work items should be ordered so that dependencies are resolved first
- **Right-size each work item so its PR stays under the `pr-diff-size` guardrail** (default `maxLines: 1000`, `maxFiles: 40`). If a planned work item is obviously larger, split it into two smaller work items at plan time — that is strictly better than letting the Coder discover the limit mid-implementation and split a single work item across multiple PRs (which the review phase then has to sequence by hand).
- Group related changes together (e.g., API endpoint + tests + documentation)
- The job's downstream loop is **coding → review → next work item** per item, with a single end-of-job evaluation. Order work items so each one is independently mergeable and reviewable in that loop — do not assume the evaluator will reconcile contracts that two sibling work items rely on at merge time.

## Implementation plan format

```
## Work Item N: {name}

**Branch name:** {branch name following git conventions}
**Base branch:** {branch to target — from job params or default to main}
**Risk level:** low / medium / high

### Changes
- File path: description of change
- File path: description of change

### Acceptance criteria
- Testable conditions that define "done"

### Build/test commands
- How to build the project
- How to run tests
```

## Setting the target language

After analyzing the repository structure, the planner must call `set_job_params({ language: "<detected-language>" })` to set the language for downstream phases. Detection heuristics:
- `go.mod` → `golang`
- `package.json` + `tsconfig.json` → `typescript`
- `*.csproj` or `*.sln` → `dotnet`
- `Cargo.toml` → `rust`
- `pyproject.toml` or `requirements.txt` or `setup.py` → `python`
- `pom.xml` or `build.gradle` (groovy DSL, no `.kts`) → `java`
- `build.gradle.kts` or any `*.kt` source → `kotlin`
- `Gemfile` or `*.gemspec` → `ruby`

The matching language conventions skill (`<language>-conventions`) is the
one downstream agents will invoke. If the repo uses a language with no
matching skill, set `language` to the closest match and `add_insight` so
the Evaluator can propose a new conventions skill.

## Branch strategy

- Use the git conventions (from your always-loaded context) for branch naming
- Target the branch specified in job params, defaulting to `main`
- For multi-work-item plans, each work item gets its own branch and PR
