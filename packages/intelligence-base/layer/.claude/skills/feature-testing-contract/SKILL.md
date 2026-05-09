---
name: feature-testing-contract
description: >-
  Contract-test methodology — verify that a producer and consumer agree on
  the shape of their interface (HTTP, message, schema, type). Crucial for
  campaign children that share contracts; for any change that introduces
  a new public surface.
---

# Contract Testing

A contract test pins the **shape and semantics** of an interface that is
shared across components, services, or campaign children. It catches the
class of bug where one side changes the format and the other side
silently breaks at runtime.

## When contract tests matter most

- A campaign child defines an interface that another child consumes.
  The producer's contract test pins the shape; the consumer's contract
  test pins the consumer's expectations. Both must pass on every change.
- A new public HTTP endpoint or message format. The contract test
  describes the request / response / payload schema and is the canonical
  reference.
- A schema migration that adds, removes, or changes a column. The
  contract test asserts the post-state schema and that the documented
  invariants (nullability, default, constraint) hold.
- A type / interface that crosses a module boundary. The contract test
  asserts the type signature is what callers expect (often via type-level
  tests in TS/Rust, generated stubs in gRPC, or a snapshot of the
  exported surface).

## Contract test shape

A contract test typically:

1. Names the contract (`POST /v1/orders v1`, `OrderCreated event v2`,
   `users.email_verified column`).
2. Encodes the shape (request / response / payload / schema / type
   signature) as data, not prose.
3. Asserts that the producer emits / accepts that shape exactly.
4. Asserts that the consumer parses / sends that shape exactly.

For HTTP endpoints, a recorded request/response pair (one happy + one
error) is usually enough. For message formats, a few representative
serialised payloads. For schemas, the canonical DDL or the project's
schema-export.

## Cross-child contract pattern (campaign-aware)

When a campaign child introduces a contract that another child consumes,
the producer writes the contract record to
`working/{parent-job-id}/contracts/{child-name}.json` (see the
`campaign-contracts` skill). The consumer's contract test loads that
file and asserts the consumer code parses it. The campaign-integrator
verifies all contracts hold post-merge.

## What contract tests must NOT do

- No exercise of the implementation behind the contract (that is unit /
  integration / e2e). Contract tests pin shape, not behaviour.
- No assertions on prose / docstrings / log lines.
- No reliance on the consumer's runtime state.

## What contract tests must do

- Run as part of the producer's CI **and** the consumer's CI.
- Fail on **any** breaking change (added required fields, removed
  fields, changed types, changed status codes).
- Be the source of truth for the contract — if the docs disagree with
  the contract test, the docs are wrong.

## Output format

Use the project's standard test runner output. Surface failures into the
`test_result.md` artefact in the format documented by the parent
`feature-testing` skill.
