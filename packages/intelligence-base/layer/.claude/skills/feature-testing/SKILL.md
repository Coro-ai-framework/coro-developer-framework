---
name: feature-testing
description: >-
  Implementation testing methodology: build verification, acceptance criteria
  verification, test result format, existing test regression checks.
  Use when testing generic implementation jobs.
---

# Implementation Testing Guide

Domain-specific guidance for testing generic implementation jobs. Used by the Evaluator agent (which now owns build/test verification on the merged commit) and by the Coder when designing tests for a work item — supplements the agent procedures with acceptance verification and regression-check methodology.

## Core approach: build verification + acceptance criteria

Implementation testing verifies that the implemented changes work correctly and don't break existing functionality. Unlike migration testing, there is no source service to compare against — the acceptance criteria from the job spec or implementation plan define the expected behavior.

## Test execution flow

1. Check out the work-item branch or main branch (post-merge)
2. Install dependencies and build the project
3. Run the project's existing test suite — all existing tests must still pass
4. Run any new tests added by the coder
5. If the work item includes a running service, start it and verify the new behavior

## Build verification

The build must pass cleanly:
- Run the language-appropriate build command
- Run the language-appropriate lint command if available
- Run the full existing test suite

If the build fails, stop immediately and report to the Evaluator.

## Acceptance criteria verification

For each acceptance criterion in the job spec or implementation plan:
- Design a test case that verifies the criterion
- Execute the test
- Record pass/fail with details

## Test result format

```json
{
  "workItem": "string",
  "tested_at": "ISO8601",
  "summary": {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "skipped": 0
  },
  "build_status": "pass|fail",
  "existing_tests_status": "pass|fail|skipped",
  "results": [
    {
      "test_case": "description",
      "criterion": "which acceptance criterion this tests",
      "status": "pass|fail|skip",
      "expected": {},
      "actual": {},
      "diff": "description if failed"
    }
  ]
}
```

## Important rules

- **Existing tests must not break** — a work item that breaks existing tests is not ready
- **Build must pass** before running any tests
- **Skipped tests need justification** — explain why each test was skipped
