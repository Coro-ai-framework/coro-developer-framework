---
name: api-design
description: >-
  Public API design checklist — REST / RPC / message-bus contracts.
  Invoked by the code-reviewer's L4 lens (cross-cutting) and by the
  Analyzer when designing new public surface in DEEP. Stack-agnostic.
---

# API Design

This skill is a **checklist for new or changed public API surface**:
HTTP endpoints, gRPC methods, GraphQL operations, message-bus
producers / consumers, public CLI commands. Invoke it whenever the diff
introduces or modifies anything an external caller can hit.

It is intentionally stack-agnostic: it asks the structural questions
that apply to REST, RPC, and async messaging alike. Tenants override or
replace this skill when their stack has stronger conventions.

## 1. Naming and shape

- **Resource-oriented for REST**: nouns, plural collections (`/orders`,
  `/orders/{id}/items`), HTTP verbs for actions. Verb-style URLs
  (`/createOrder`) only when the action is genuinely RPC and REST is a
  bad fit.
- **Operation-oriented for RPC / messages**: verb names that read like
  the intent (`OrderCreated`, `CreateOrder`). Past-tense for events
  (something happened); imperative for commands (someone is asked to
  do something).
- **Consistent casing**: pick one (snake_case or camelCase) per surface
  and stick to it. Mixed casing in one payload is a bug.
- **No abbreviations** unless they are domain-standard (`HTTP`, `URL`,
  `ID`). `addr` for `address` is not domain-standard.

## 2. Versioning

- Every public surface declares a version (URL prefix `/v1/`, header
  `Api-Version: 1`, message envelope `version: 1`, gRPC package
  `acme.orders.v1`).
- Additive changes (new optional field, new endpoint) do **not** bump
  the version.
- Breaking changes (removed field, type change, semantics change,
  required-field added) bump the version. The previous version stays
  alive until consumers migrate.
- A "v0" or "alpha" version is acceptable only if the surface is
  explicitly documented as unstable.

## 3. Compatibility

- New fields are **optional with a default** that preserves prior
  behaviour. Required new fields are a breaking change.
- Removed fields go through a deprecation window — at minimum one
  release of dual-emit / dual-accept.
- Enum / status values added to a response are safe; values added to a
  request are breaking unless the producer ignores unknowns.
- Date / time fields are ISO-8601 strings or epoch milliseconds —
  document which, never both.

## 4. Error model

- Pick one error envelope per surface and reuse it. Inconsistent error
  shapes are the most common API smell.
- Errors carry a stable `code` (machine-readable, e.g.
  `order.not_found`), a human-readable `message`, and optionally a
  per-field `details[]` array for validation errors.
- HTTP status codes match the semantics: 4xx for client errors, 5xx
  for server errors, 409 for conflict, 422 for validation, 429 for
  throttle. Returning 200 with `{"error": ...}` is forbidden unless
  the project explicitly chose that pattern (rare).
- Idempotent operations document the idempotency contract — usually a
  client-supplied key in a header or field.

## 5. Pagination, filtering, sorting

- Every list endpoint paginates. Cursor-based by default; offset-based
  only when the dataset is small and bounded.
- Filter / sort parameters are **named** (`?status=open&sort=-createdAt`),
  not positional.
- Maximum page size is documented and enforced server-side.

## 6. Authentication and authorisation

- Every public endpoint declares its auth requirement explicitly. No
  endpoint silently inherits "auth optional".
- Authorisation is checked **before** any work that has side effects
  or reads sensitive data. Don't 404-instead-of-403 unless the spec
  explicitly says so for information-disclosure reasons.
- Tokens / API keys never appear in URLs (logging risk). Use headers.

## 7. Observability of the surface itself

- Each endpoint emits a structured access log line with status code,
  latency, caller id (when available), and route template (not the
  full path with ids — too cardinal for metrics).
- Each endpoint has request-count + latency + error-rate metrics with
  the route template as a label.
- Errors have enough context in the log line to debug from the line
  alone.

## 8. Documentation

- Every public surface is documented in the project's standard format
  (OpenAPI / proto / AsyncAPI / RFC) **in the same PR** that adds it.
- The contract test (see `feature-testing-contract`) is the source of
  truth — docs that disagree with the contract test are wrong.

## Output integration

When invoked by the code-reviewer L4 lens, surface the highest-impact
finding (or "ok") in the `cross-cutting` section's `dependency-hygiene`
peer. When invoked by the Analyzer, fold the findings into the
`Contracts introduced or changed` section of `design-notes.md`.
