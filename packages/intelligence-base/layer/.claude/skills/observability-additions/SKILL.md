---
name: observability-additions
description: >-
  Observability checklist — logs, metrics, traces, and runtime health
  signals added or changed in a diff. Invoked by the code-reviewer L4
  lens. Stack-agnostic; tenants override with their own log/metric/trace
  conventions.
---

# Observability Additions

This skill is a **checklist for the observability surface** of a
change: structured logs, metrics, distributed traces, and runtime
health signals. Invoke it whenever the diff adds a new code path that
runs in production.

It is intentionally stack-agnostic. Tenants typically override or
extend with project-specific log fields, metric naming conventions, and
trace attribute schemas.

## 1. Logs

- **Structured, not stringly**. New log lines use the project's
  structured logger with named fields, never `printf`-style
  concatenation.
- **Right level**:
  - `debug` for verbose internals only (off in prod).
  - `info` for steady-state milestones (one per request / job, not per
    sub-step).
  - `warn` for degraded behaviour the system recovered from.
  - `error` for failures that need human attention.
- **No leftover debug**. `println` / `console.log` / `fmt.Println` /
  `dbg!` / `eprintln!` are red flags in any diff.
- **No secrets**. New log lines do not include auth headers, tokens,
  query strings with credentials, or full PII. Spot-check by searching
  the diff for `Authorization`, `password`, `token`, `apiKey`, `email`.
- **Enough context to debug from one line**: the operation name, the
  key identifier (request id, user id, work-item id), and the upstream
  error if any.
- **No log floods**. A new code path that runs in a tight loop must
  rate-limit or sample its logs.

## 2. Metrics

- **Standard request shape** for new endpoints / handlers: a
  request-count counter, a latency histogram, an error-count counter.
  Labels include the route template (not the full URL — too cardinal),
  the status class (`2xx`, `4xx`, `5xx`), and the caller tier.
- **Standard background-work shape** for new jobs / consumers:
  processed-count, failed-count, in-flight gauge, processing-latency
  histogram.
- **No high-cardinality labels**. User id, request id, full URL — any
  label whose value space is unbounded — must not appear on metrics.
  Put those in logs / traces.
- **Naming**: follow the project's existing convention exactly. If the
  project uses `service_request_total`, do not add `myservice.requests`.

## 3. Traces

- **Span around the boundary** the spec called out as observable:
  request handlers, message consumers, external calls, transactions
  longer than a few milliseconds.
- **Span attributes** follow the project's convention. At minimum,
  include the operation name, the key identifier, and any error code.
- **No sensitive attributes** — same rule as logs: no secrets, no full
  PII.
- **Errors are recorded on the span** (`span.recordException`,
  `span.setStatus(Error)` — depends on the SDK).

## 4. Health and readiness

- New background work registers with the project's health check (or
  documents why it does not need to).
- New external dependencies (a new DB, a new queue, a new third-party
  API) appear in the readiness check.

## 5. Alerting (when applicable)

- New SLO-impacting code paths come with a documented alert (or a TODO
  to add one in a follow-up).
- New error categories that the project doesn't already alert on are
  flagged for the operator.

## 6. Cost discipline

- A new high-volume metric or log line documents its expected volume.
- Sampling decisions for new traces are explicit (default to the
  project's sampler; deviate only with a reason).

## Output integration

When invoked by the code-reviewer L4 lens, surface the highest-impact
finding (or "ok") in the `cross-cutting` section's `observability` peer.
Findings are usually non-blocking unless a missing piece would prevent
debugging a known failure mode.
