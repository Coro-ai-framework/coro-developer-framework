# Migration Planning Guide

Domain-specific guidance for producing migration plans. Supplements the generic Planner agent instructions with migration-specific ordering heuristics and conventions.

## Feature grouping rules

- Group endpoints by domain/resource (e.g., all `/users/*` endpoints in one feature)
- Keep shared infrastructure as the first feature (project scaffolding, config loading, middleware, auth, health check)
- Keep high-traffic, high-risk endpoints in their own features so failures are isolated
- Group low-traffic, low-risk endpoints together to reduce PR count
- Database migrations are NOT in scope — the target service connects to the same DB as the source

## Feature 1 is always infrastructure

Feature 1 must set up the project foundation:
- Module/project initialization with the target language's conventions
- Config loading from env vars (mapped from helm values)
- Structured logging setup
- HTTP server and router
- Health endpoint at `GET /health`
- Auth middleware skeleton
- Global error/panic recovery middleware
- Graceful shutdown

Read `helm-app-config/staging/{service-name}/values.yaml` to identify all required env vars and define them as config fields.

## Ordering rules

1. Feature 1 is infrastructure (always first)
2. Order remaining features by: dependencies first, then high-traffic before low-traffic, then complexity low-to-high
3. If a feature has a known pitfall in memory, flag it explicitly and note the mitigation

## Risk assessment

| Risk | Indicators |
|------|-----------|
| High | Complex auth logic, dynamic response shapes, heavy middleware, external service dependencies, high traffic volume, known pitfall applies |
| Medium | Moderate complexity, some external calls, medium traffic |
| Low | Simple CRUD, no external calls, low/zero traffic |

## Feature format

Each feature in the plan should include:

```
## Feature N: {name}

**Branch name:** feature/{service-name}-{short-description}
**Risk level:** low / medium / high
**Traffic volume:** (from baseline, or "unknown")
**Depends on:** Feature N (list any features that must be merged first)

### Endpoints
- METHOD /path/to/endpoint

### Key concerns
- List any known difficulty, pitfall, or required care
- Reference memory/known-pitfalls.md entries that apply

### Acceptance criteria
- List testable conditions that define "done"
```

## Migration summary section

At the end of the plan, include:

```
## Migration Summary

- Total features: N
- Estimated PR count: N
- High-risk features: list them
- Gaps (things the Analyzer couldn't determine): list them
- Configuration keys required (from helm-app-config): list all env vars
```

## Setting the target language

After producing the plan, the planner must call `set_job_params({ language: "<target-language>" })` to set the target language for downstream phases. For migration jobs, this is the language being migrated TO (not the source language). All downstream coding phases with `conventions: [auto]` will then load the correct conventions automatically.
