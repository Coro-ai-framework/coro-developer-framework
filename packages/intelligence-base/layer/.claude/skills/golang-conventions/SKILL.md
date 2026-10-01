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

## Coro job workspace

Coro clones the target repo into a subdirectory of the job working directory, not at the job root.

- **Job root:** `working/{jobId}/` — Bash may start here; `go.mod` is usually **not** here.
- **Repo:** `params.repoCheckoutAbsDir` or `working/{jobId}/{repoCheckoutDir}/` — all `go` and `git` commands run here.
- Always prefix: `cd <repoCheckoutDir> && …` (relative dir from `scm_clone_repo` or job context).

## Build verification (Coro runner)

From the **job root** (`JOB` below), with repo relative dir `REL` (e.g. `a5labs.kyc.go`):

```bash
cd "$REL" && mkdir -p "$JOB/.cache/go-build" && \
  GOCACHE="$JOB/.cache/go-build" go build -buildvcs=false ./...
```

- Use **`GOCACHE` under the job root** (always writable). Inherit **`GOMODCACHE`** and **`GOPROXY`** from the environment on the happy path — the shared module cache is warm and saves a lot of downloading.
- **Never place a cache under `$TMPDIR`.** If you need a job-local cache, put it under the job root so it is inside `$PWD` and gets cleaned up with the job.
- Scope packages per the implementation plan (e.g. `./internal/persistence/...` only when the plan says so).

### When the shared module cache is not writable

`go build` / `go mod download` failing with `operation not permitted` under
`$HOME/go/pkg/mod` means the host sandbox is denying the write (see
`sandbox-recovery`). The same error on a `.gitmodules`, `.idea/`, or
`.vscode/` file inside an *already-cached* module means a job-local
`GOMODCACHE` is re-extracting a module needlessly — the shared cache is still
**readable**.

**No new module needed** — build read-only against the warm cache:

```bash
cd "$REL" && GOFLAGS=-mod=mod GOPROXY=off \
  GOCACHE="$JOB/.cache/go-build" go build -buildvcs=false ./...
```

**A new module is needed** — pre-seed a job-local `GOMODCACHE` by symlinking
only the shared cache's already-extracted `@version` leaves, not the
host/owner directories above them: those need to stay real, writable
directories in `$JOB` so Go can create the new module's entry inside them —
symlinking a host dir itself (e.g. `github.com`) makes every write beneath it
resolve back into the read-only shared cache and fail the same way:

```bash
mkdir -p "$JOB/.cache/gomod"
find "$HOME/go/pkg/mod" -path "$HOME/go/pkg/mod/cache" -prune -o \
  -type d -name '*@*' -print -prune 2>/dev/null | while read -r d; do
  rel="${d#"$HOME"/go/pkg/mod/}"
  mkdir -p "$JOB/.cache/gomod/$(dirname "$rel")"
  ln -s "$d" "$JOB/.cache/gomod/$rel"
done
cd "$REL" && GOFLAGS=-mod=mod GOCACHE="$JOB/.cache/go-build" \
  GOMODCACHE="$JOB/.cache/gomod" \
  GOPROXY="file://$HOME/go/pkg/mod/cache/download,direct" \
  go build -buildvcs=false ./...
```

Pruning `cache/` matters: it holds the download cache's own `@v` metadata
directories, which would otherwise get symlinked too — adding a previously
uncached version of an already-cached module then tries to write its
`.lock`/`.mod`/`.zip` there and hits the same `operation not permitted`. The
job-local `$JOB/.cache/gomod/cache/` is left to be created fresh and
writable. `GOCACHE` is set here for the same reason the happy path above
requires it — a build in this branch still needs a writable build cache.

If the new module is private and hosted on your SCM, add
`GOPRIVATE='<scm-host>/<org>/*'` so Go fetches it straight from there instead of
`proxy.golang.org` / `sum.golang.org`, which a host allowlist may not permit.
`GOPRIVATE=''` does not clear an inherited value — pass a sentinel host that
matches nothing (e.g. `GOPRIVATE='none.invalid/*'`) when you need it empty.

## Test verification (Coro runner)

```bash
cd "$REL" && GOCACHE="$JOB/.cache/go-build" go test ./...
```

For long runs, redirect to a file under the job root: `go test ./... > test-output.txt 2>&1; echo "EXIT:$?" >> test-output.txt`

## Failure policy

After two failed build attempts with the same goal: `add_insight` + `escalate`.

The one exception is a **sandbox write denial** (`operation not permitted` under
`$HOME/go`, or on a `.gitmodules`/`.idea/`/`.vscode/` file during extraction).
That has a known single-shot fix — the read-only or symlink-seeded recipe
above, matched to whether a new module is needed — so apply it once before you
count attempts. If it also fails, escalate with both errors. Never bump or
unpin a dependency to get around a cache or network restriction.

### Vendoring a module that ships a `.gitmodules` file

The host sandbox refuses to write any file named `.gitmodules` (`operation not
permitted`), which breaks `go get` / `go mod download` for a module whose repo
has one (e.g. `github.com/swaggo/files`). Fetch only the file(s) your code
imports from `raw.githubusercontent.com` instead of letting Go clone the repo:

```bash
mkdir -p "$REL/internal/vendored"
curl -fsSL "https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>" \
  -o "$REL/internal/vendored/<name>"
```

Do not add the module as a normal `go.mod` dependency once it needs this.

### Building a tool CLI so `replace` directives apply

`go install pkg@version` resolves at a pinned version and ignores any
`replace` in your `go.mod` — it always builds the upstream code. To build a
generated-code tool (e.g. `protoc-gen-go`) against a `replace`d fork, build it
**from inside the target module** instead:

```bash
cd "$REL" && mkdir -p "$JOB/.cache/bin" && GOCACHE="$JOB/.cache/go-build" \
  go build -o "$JOB/.cache/bin/<tool>" <tool-import-path>
```

This resolves the tool through the module's own `go.mod`, so local `replace`
entries apply.

### Job-local Git config for private vanity-import modules

A stale `osxkeychain` credential helper can hang or fail silently on `go get`
auth probes for a private, vanity-import module. Blank it and add a scoped
`insteadOf` via a job-local config file rather than touching `~/.gitconfig`:

```bash
cat > "$JOB/.git-config-job" <<'EOF'
[credential]
    helper =
[url "https://<scm-host>/<org>/"]
    insteadOf = https://<vanity-host>/<org>/
EOF
cd "$REL" && GIT_CONFIG_GLOBAL="$JOB/.git-config-job" GOPRIVATE='<vanity-host>/<org>/*' GONOSUMDB='<vanity-host>/<org>/*' go get <vanity-host>/<org>/<module>@<version>
```

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
