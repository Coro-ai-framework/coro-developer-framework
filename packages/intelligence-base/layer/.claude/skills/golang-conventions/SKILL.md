---
name: golang-conventions
description: >-
  Go coding standards for Coro-managed services: project layout, dependencies
  (chi, zerolog, pgx), naming, error handling, config, testing, HTTP patterns.
  Use when writing or reviewing Go code.
---

# Go Coding Conventions

> **Note to developer (Emre):** This is a starter file. Please enhance it with your team's specific preferences.
> Agents will read this file strictly — anything you add here becomes a rule they follow.

## Project Layout

```
{service-name}/
├── cmd/
│   └── server/
│       └── main.go          ← Entry point only; no logic here
├── internal/
│   ├── config/
│   │   └── config.go        ← Env var loading (all config in one struct)
│   ├── handler/
│   │   └── *.go             ← HTTP handlers (one file per resource group)
│   ├── middleware/
│   │   └── *.go             ← HTTP middleware
│   ├── model/
│   │   └── *.go             ← Request/response structs
│   ├── service/
│   │   └── *.go             ← Business logic (no HTTP concerns here)
│   └── repository/
│       └── *.go             ← Database access
├── go.mod
├── go.sum
├── Dockerfile
└── .gitignore
```

## Dependencies (defaults — enhance as needed)

| Purpose | Package |
|---------|---------|
| HTTP router | `github.com/go-chi/chi/v5` |
| Structured logging | `github.com/rs/zerolog` |
| Config from env | `github.com/kelseyhightower/envconfig` |
| PostgreSQL | `github.com/jackc/pgx/v5` |
| Testing assertions | `github.com/stretchr/testify` |

> **TODO (Emre):** Confirm or replace preferred packages above.

## Naming

- Package names: short, lowercase, no underscores (`handler`, `model`, not `handlers`, `data_model`)
- Exported types: PascalCase matching the .NET DTO name where possible for traceability
- JSON tags: must exactly match the .NET contract (verify against `service-contract.json`)
- Error variables: `ErrNotFound`, `ErrUnauthorized` style

## Error handling

- Return errors; never panic in business logic
- Use `fmt.Errorf("context: %w", err)` for wrapping
- HTTP handlers convert errors to appropriate status codes centrally in middleware — handlers should return domain errors, not HTTP errors directly

> **TODO (Emre):** Define your standard error response shape here if you have one across services.

## Configuration

All config loaded once at startup from env vars into a single typed struct:

```go
type Config struct {
    Port        int    `envconfig:"PORT" default:"8080"`
    DatabaseURL string `envconfig:"DATABASE_URL" required:"true"`
    // ... add fields as needed
}
```

No `os.Getenv` calls outside the config package.

## Testing

- Table-driven tests with `t.Run()`
- Test files in same package as the code they test (`handler_test.go` alongside `handler.go`)
- Mock interfaces, not concrete types
- Subtests named descriptively: `"returns 400 when email is missing"` not `"test2"`

## Logging

Use `zerolog` with structured fields. Every request logs at minimum:
- Method, path, status code, duration
- Request ID (from header or generated)

No `fmt.Println` or `log.Println` in production code.

## HTTP response conventions

> **TODO (Emre):** Define your standard response envelope if you use one (e.g., `{"data": ..., "error": null}`).

Default (no envelope):
- Success: return the DTO directly as JSON
- Validation error: `{"errors": {"fieldName": ["message"]}}` (matches .NET ValidationProblemDetails)
- Server error: `{"type": "...", "title": "...", "status": 500, "detail": "..."}` (ProblemDetails)

## What to enhance in this file

- [ ] Confirm router choice (chi vs gin vs stdlib)
- [ ] Confirm logging library
- [ ] Define standard error response shape
- [ ] Define any response envelope conventions
- [ ] Add auth middleware conventions (JWT validation approach)
- [ ] Add database connection pool settings
- [ ] Add Dockerfile base image and build stage conventions
- [ ] Add any company-specific package or tooling requirements
