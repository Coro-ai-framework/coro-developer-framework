---
name: cross-cutting-review
description: >-
  Cross-cutting review checklist used by the code-reviewer subagent in
  STANDARD and DEEP lanes (lens L4). Covers security, performance,
  observability, dependency hygiene, and accessibility. Skipped on the FAST
  lane. Read once per review pass.
---

# Cross-Cutting Review

This skill is the L4 lens of the code-reviewer subagent. It is **not** a
language conventions skill — it asks structural questions that apply to any
language. Invoke it after L1 (conventions/plan/tests/pitfalls) and L2
(register/scope) have passed; if either of those is blocking, fix that first.

The reviewer reads `params.lane` and only invokes this skill when `lane !==
"fast"`. FAST jobs are explicitly scoped small enough that the cost of running
this lens isn't paid back; if you find yourself wanting it on a FAST job, the
Coder mis-classified — escalate via `add_insight` so the Planner's
classification accuracy is reviewed.

## How to apply

Walk the diff once per category. For each category, write **one finding** at
most: either "ok" with a one-line justification, or a blocking/non-blocking
item with a file:line and a fix suggestion. Do **not** generate noise — empty
categories should be reported as `ok`, not omitted.

When a category has a deeper domain skill, **invoke it** for a focused
checklist. The domain skills add depth where the general checklist below
only signals presence:

| Trigger in the diff | Invoke domain skill |
|---|---|
| New / changed public HTTP endpoint, RPC, GraphQL op, message format | `api-design` |
| New / changed migration file (SQL, ORM migration, schema export) | `db-migrations-safe` |
| New / changed log line, metric, span, health check, alert rule | `observability-additions` |
| New / changed CI / CD config (.github/workflows, .gitlab-ci.yml, Jenkinsfile, …) | `ci-cd-authoring` |
| New / removed / upgraded dependency in any manifest or lockfile | `dependency-hygiene` |

Domain-skill findings are surfaced in the same one-line-per-category
output below; the skill's own output guidance explains where it lands.

## Categories

### 1. Security

- **Input validation**: every value coming from a request, message, env var,
  or config is validated at the boundary. Length limits, type checks, allow
  lists where applicable.
- **Secrets**: no credentials, tokens, or private keys in the diff. No new
  log lines that could include secrets (auth headers, query strings with
  tokens, exception payloads).
- **Authn/authz**: every new public endpoint or message handler enforces the
  expected authentication and authorisation. New roles/permissions are
  registered in the same diff.
- **Injection surfaces**: SQL, shell, template, path, regex, deserialisation
  — anything that takes user input and feeds it to an interpreter must use
  parameterised / sandboxed APIs.
- **PII handling**: PII is logged only when explicitly required, with the
  appropriate redaction. Storage of PII matches the data-class declared in
  the spec.

### 2. Performance

- **N+1 queries / loops calling I/O**: any loop that performs DB / RPC / file
  I/O has a defensible upper bound or batches the calls.
- **Allocations in hot paths**: tight loops avoid unnecessary allocations,
  string concatenation, or boxing.
- **Blocking calls on async paths**: no synchronous I/O on event loops, no
  blocked goroutines / threads waiting indefinitely.
- **Caching**: new caches have a documented invalidation path; existing
  caches affected by the change are invalidated where they should be.
- **Pagination / bounded results**: every list endpoint added or modified
  paginates or has a documented hard limit.

### 3. Observability

- **Logs**: new code paths emit structured logs at the agreed level (info on
  success, warn on degraded, error on failure). No `println` / `console.log`
  / `fmt.Println` debug stragglers.
- **Metrics**: new endpoints/handlers register the standard request count +
  latency + error metrics for the language. New background work registers
  job-status metrics.
- **Traces**: spans exist around the boundaries the spec called out as
  observable. Span attributes follow the project's convention.
- **Error context**: errors are wrapped with enough context to debug from a
  log line alone (operation, key identifiers, upstream cause).

### 4. Dependency hygiene

- **New dependencies**: any added third-party dep has a one-line
  justification (in PR description or a `decisions[]` entry in the register),
  is pinned to a specific version, and is licensed compatibly.
- **Removed dependencies**: nothing left importing a removed dep.
- **Version bumps**: a major version bump has a documented migration note.
- **Native / OS deps**: new native bindings or system packages are recorded
  in the project's manifest (Dockerfile, devcontainer, CI image).

### 5. Accessibility (when the diff touches UI)

- **Semantic HTML / native components**: prefer semantic elements over
  generic divs; use the platform's accessibility primitives.
- **Keyboard navigation**: every new interactive control is reachable and
  operable via keyboard.
- **Labels / alt text**: form controls have labels; images have alt text or
  are explicitly decorative.
- **Colour contrast**: new colour combinations meet the project's contrast
  target.
- **Live regions**: dynamic UI updates that matter to a screen reader use
  the appropriate ARIA live region.

## Output integration

Append a section to the reviewer's report:

```
### Cross-cutting (L4)
- security: <ok | finding>
- performance: <ok | finding>
- observability: <ok | finding>
- dependency-hygiene: <ok | finding>
- accessibility: <ok | finding | n/a — no UI changes>
```

Findings carry the same `blocking | non-blocking` classification as the rest
of the report — promote them to the top-level Blocking / Non-blocking lists
so the Coder doesn't have to re-scan.
