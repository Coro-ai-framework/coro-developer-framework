# Migration Coding Guide

Domain-specific guidance for implementing migration features. Supplements the generic Coder agent instructions with migration-specific contract parity rules and translation patterns.

## Contract parity — the cardinal rule

The migrated service must be a drop-in replacement for the source service. Every endpoint must match the source service's behavior exactly unless a deviation is documented and justified.

## Request/response shape rules

- **Field names in JSON must exactly match the source contract** (case-sensitive — check for serialization attribute overrides like `[JsonProperty]` in the contract)
- **Nullable fields** in the source map to pointer/optional types in the target language
- **DateTime fields:** Use the same format as the source service (typically RFC3339/ISO 8601)
- **TimeSpan / Duration fields:** Serialize as ISO 8601 duration strings (e.g., `PT1H30M`) — this is a known pitfall
- **Enums:** Serialize as their string name, not integer value, unless the contract specifies integer serialization

## Status code matching

Return exactly the status codes documented in the contract:
- **400** for validation errors — return the same error shape as the source service's validation error response
- **404** when a resource is not found
- **401/403** for auth failures
- **500** for unhandled errors — return a structured error shape matching the source (e.g., `ProblemDetails`: `{"type": ..., "title": ..., "status": 500, "detail": ...}`)

## Validation behavior

The source service may automatically validate request models before the handler runs. This implicit validation must be explicitly implemented:
- Check for required fields
- Validate range constraints, string length, regex patterns
- Return the same validation error response shape

## Auth alignment

- Implement auth middleware to match the source service's auth policy exactly
- If the source uses JWT bearer tokens, validate the same claims and issuer
- Match auth error response shapes

## External dependencies

- **HTTP clients:** Use the same timeouts as configured in the source service
- **Database:** Use the target language's idiomatic database driver. Match connection pool settings from helm config.
- **Cache:** Maintain the same cache keys and TTL values

## .NET-to-Go specific patterns

When migrating from .NET to Go:

- **Router:** Use `chi` for HTTP routing — it supports the same route patterns
- **Logging:** Use `zerolog` for structured logging
- **Config:** Load from environment variables using `envconfig` or `viper`, mapped from helm values
- **Error responses:** Implement `ProblemDetails` as a Go struct with JSON tags
- **Validation:** Implement manually or use `go-playground/validator`
- **DateTime:** Use `time.Time` with `time.RFC3339`
- **Nullable types:** Use pointer types (`*string`, `*int`, etc.)
- **DB access:** Use `pgx` for PostgreSQL, `database/sql` with appropriate driver otherwise

## Test requirements

For every handler:
- Unit test the handler function with mock dependencies
- Table-driven tests covering: happy path, validation errors, not found, auth failure
- Tests must compile and pass locally before the PR is opened

## PR requirements

PR description must include:
- Which feature from the migration plan this implements
- Endpoints implemented (method + path)
- Any deviations from the source contract and the reason
- Known gaps or follow-up items

## Critical rules

- **Never change an API contract** unless the source code itself is ambiguous and the decision is documented in the PR description
- **Never silently omit an endpoint** — if you can't implement it, open the PR with a TODO comment and explain in the description
- **Always match error response shapes** — clients depend on the exact structure
- **No speculative features** — implement exactly what the contract specifies, nothing more
