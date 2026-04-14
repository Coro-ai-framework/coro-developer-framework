---
name: feature-planning
description: >-
  Feature scoping and planning: spec analysis, feature breakdown, implementation
  plan format, language detection, branch strategy. Use when planning feature
  implementations in existing services.
---

# Feature Planning Guide

Domain-specific guidance for planning feature implementations in existing services. Supplements the generic Planner agent instructions with feature-specific scoping and planning conventions.

## Scoping from a spec or description

When planning a feature implementation:

1. **Understand the request:** Read the feature spec or description thoroughly. Identify the specific behavior changes, new endpoints, UI changes, or backend logic required.
2. **Identify affected files:** Map which files in the existing codebase need to be modified or created.
3. **Assess scope:** Break the work into logical features if the change is large enough to warrant multiple PRs. For small features, a single feature/PR is fine.
4. **Check dependencies:** Identify if any existing code needs to be refactored first, or if new dependencies need to be added.

## Feature breakdown rules

- Each feature should be a self-contained, mergeable unit of work
- Features should be ordered so that dependencies are resolved first
- Keep changes small enough for meaningful code review (under ~500 lines of diff when possible)
- Group related changes together (e.g., API endpoint + tests + documentation)

## Implementation plan format

```
## Feature N: {name}

**Branch name:** feature/{short-description}
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
- `requirements.txt` or `pyproject.toml` → `python`

## Branch strategy

- Use the git conventions (from your always-loaded context) for branch naming
- Target the branch specified in job params, defaulting to `main`
- For multi-feature plans, each feature gets its own branch and PR
