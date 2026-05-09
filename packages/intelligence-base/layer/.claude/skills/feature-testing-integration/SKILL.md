---
name: feature-testing-integration
description: >-
  Integration-test methodology — exercise multiple components together
  with real adapters (real DB, real filesystem, real HTTP loopback). Slower
  than unit tests; catches wiring and contract bugs that unit tests miss.
---

# Integration Testing

Integration tests verify that two or more components cooperate correctly
when wired up the way the production app wires them. They use **real
adapters** to the surrounding world: a real database (often
ephemeral / in-container), a real filesystem (often `/tmp`), a real HTTP
client hitting a loopback server.

## When to write an integration test

- Every new HTTP endpoint or message handler.
- Every database access path that involves more than a single trivial
  query (joins, transactions, optimistic concurrency).
- Every adapter to an external system, mocked at the network boundary
  (recording / replay) but otherwise exercised end-to-end through the
  app's own code.
- Every non-trivial migration: an integration test that runs the
  migration against a populated test DB and asserts the post-state.

## Test environment expectations

- Ephemeral DB (testcontainers, or the project's standard test DB
  fixture). Schema rebuilt or transaction-rolled-back per test.
- Loopback HTTP server (the project's standard test harness).
- Recorded responses for any third-party API the project does not own.
- Tests must be runnable without internet access; record-and-replay is
  the contract, not "live API allowed in CI".

## What integration tests must NOT do

- No reliance on shared mutable state across tests. Each test owns its
  fixture.
- No assertion on log output unless the log line is part of the contract
  (which is rare).
- No assertion on response timing unless the test is explicitly a
  performance regression test (different tier).

## What integration tests must do

- Test the wiring as production wires it. If production reads a config
  file, the test reads a fixture config file. If production runs a
  migration on startup, the test runs the migration.
- Cover the same acceptance criteria the unit tests cover only at the
  pure-function level — but at the wired-up level. Both layers add
  value.
- Run in seconds, not minutes. A 30-second integration test is on the
  edge; flag if it goes higher.

## Common pitfalls

- "Integration test that mocks the database" is a unit test in disguise.
  Use a real (in-container) DB or accept that you have a unit test.
- Cross-test pollution. Always clean up; never depend on test ordering.
- Asserting on stable error messages. Error messages are not the contract;
  status codes and error codes are.

## Output format

Use the project's standard test runner output. Surface failures into the
`test_result.md` artefact in the format documented by the parent
`feature-testing` skill.
