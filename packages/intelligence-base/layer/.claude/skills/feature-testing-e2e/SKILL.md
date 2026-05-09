---
name: feature-testing-e2e
description: >-
  End-to-end test methodology — exercise the deployed system through its
  outermost interface (HTTP / CLI / UI). Slowest tier; smallest count.
  Catches what every other tier misses.
---

# End-to-End Testing

E2E tests verify the system as a real user (or upstream caller) would
hit it: through the deployed HTTP API, the published CLI, or the
rendered UI. They are the slowest, most expensive, and least numerous
tests in the suite.

## When to write an E2E test

- For each headline acceptance criterion — the user-visible promise the
  feature makes. One E2E per acceptance criterion is a healthy ratio.
- For each campaign — a campaign-level happy path that exercises the
  union of children's behaviour. The `campaign-integrator` agent owns
  this for the campaign workflow.
- For each rollback / feature-flag toggle. If a flag exists, an E2E
  test exercises both branches.

## Test environment expectations

- A deployed instance of the system (local docker-compose, k8s
  ephemeral, staging cluster — whatever the project uses).
- Real database, real message bus, real auth flow. Mocking at the E2E
  tier defeats the point.
- A test user / test tenant so the E2E does not pollute real data.

## What E2E tests must NOT do

- No assertion on internal implementation details (specific log lines,
  internal state, query plans). Anything you cannot observe from the
  outermost interface is out of scope.
- No "many tests sharing one expensive setup". Either each test stands
  alone (preferred), or the suite documents the ordering contract
  (last-resort).
- No flaky retries. An E2E test that needs `retries=3` is a bug in the
  test or the system.

## What E2E tests must do

- Drive the system through its real interface. For HTTP, real HTTP
  client. For CLI, spawn the binary. For UI, drive the rendered page
  with a real browser automation library.
- Cover the **happy path** plus at least one user-visible failure
  (auth denied, validation error, downstream unavailable).
- Run after every merge to the integration branch. They are too slow
  for per-commit but too important to skip.

## Cost discipline

E2E tests are the most expensive tier per assertion. Treat new E2E
tests as a budgeted resource: each test must justify itself by
covering a behaviour that no cheaper tier can verify.

If you find yourself writing an E2E test to compensate for a missing
unit / integration / contract test, the gap is at the cheaper tier —
fill it there first.

## Output format

Use the project's standard test runner output. Surface failures into the
`test_result.md` artefact in the format documented by the parent
`feature-testing` skill.
