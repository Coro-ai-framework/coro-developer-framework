---
name: feature-testing-unit
description: >-
  Unit-test methodology — fast, isolated tests of pure functions and small
  classes. Run on every commit. Lowest tier; no I/O, no clock, no network.
---

# Unit Testing

Unit tests verify the smallest behaviour units in isolation: a pure
function, a small method, a single class. They are the cheapest, fastest,
and most numerous tests in the suite.

## When to write unit tests

- Any new pure function or class with non-trivial logic.
- Any branch in conditional code that is not trivially obvious.
- Any error-handling path. Each `throw` / `return Err(...)` deserves a
  test that triggers it.
- Any boundary condition (empty inputs, single element, max size,
  zero, negative, off-by-one).

## What unit tests must NOT do

- No I/O (no DB, no filesystem, no network, no real HTTP).
- No real clock (use injected time, fake timers, or freeze time).
- No real randomness (inject a seeded RNG or stub it).
- No reliance on environment variables, working directory, or shared
  global state.
- No sleeps. If a test waits, it is not a unit test.

## What unit tests must do

- Run in milliseconds. A unit test slower than ~50ms is suspect.
- Pass deterministically on every run. Flake = bug, not "re-run".
- Cover one behaviour per test (Arrange / Act / Assert; one Act).
- Name the behaviour, not the implementation: `returnsZeroOnEmptyInput`
  beats `testEmptyInput`.

## Coverage signal, not target

Aim for high coverage of the **changed surface**, not absolute coverage.
A new function with 4 branches deserves 4 (+ boundaries) tests; a new
function that simply forwards a call may not need a unit test at all
(the integration test will catch it).

## Common pitfalls

- Asserting on internal state instead of public behaviour. If you find
  yourself reaching into private fields, the public API probably has a
  gap.
- Snapshot tests for non-stable output. Snapshots that include
  timestamps, ids, hashes, or formatting that the test runner controls
  produce false positives.
- Heavy mocks. If a test needs more than ~3 mocks to set up, the unit
  under test has too many collaborators — that is a design smell and
  should be flagged in the review, not absorbed.

## Output format

Use the project's standard test runner output. Surface failures into the
`test_result.md` artefact in the format documented by the parent
`feature-testing` skill.
