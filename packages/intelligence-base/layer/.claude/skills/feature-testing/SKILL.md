---
name: feature-testing
description: >-
  Implementation testing methodology — index. Build verification, acceptance
  criteria verification, test result format, and pointers to the four
  testing tiers (unit, integration, contract, e2e). Use for any
  implementation job; pick tiers based on the work-item type.
---

# Implementation Testing Guide (index)

Domain-agnostic testing methodology for generic implementation jobs.
Used by the QA agent (DEEP lane) and the Evaluator (STANDARD / FAST
lanes) for build / test / acceptance verification, and by the Coder when
designing tests for a work item.

This skill is an **index**. The bulk of the methodology lives in four
tier-specific skills; invoke them as needed:

| Tier | Skill | When to invoke |
|------|------|---------------|
| Unit | `feature-testing-unit` | New pure functions, classes, or branches; always for new logic |
| Integration | `feature-testing-integration` | New endpoints, message handlers, DB adapters, wired-up flows |
| Contract | `feature-testing-contract` | New public surface (HTTP, message, schema, type) or cross-child contracts in a campaign |
| E2E | `feature-testing-e2e` | Headline acceptance criteria; campaign-level integration; rollback / feature-flag exercises |

A typical job exercises 2–3 tiers. Pick by reading the work item:
- "Add a pure helper" → unit only.
- "Add a new endpoint" → unit + integration + contract.
- "Add a new feature exposed to users" → unit + integration + contract +
  e2e (one E2E for the headline path).
- "Refactor without behaviour change" → unit + integration; reuse
  existing E2E unchanged (characterisation-style).

## Core approach: build verification + acceptance criteria

Implementation testing verifies that the implemented changes work
correctly and don't break existing functionality. Unlike migration
testing, there is no source service to compare against — the acceptance
criteria from the job spec or implementation plan define the expected
behaviour.

## Test execution flow

1. Check out the work-item branch or main branch (post-merge).
2. Install dependencies and build the project.
3. Run the project's existing test suite — all existing tests must
   still pass.
4. Run any new tests added by the coder, organised by tier.
5. If the work item includes a running service, start it and verify the
   new behaviour through an E2E test.

## Build verification

The build must pass cleanly:
- Invoke the job's **`{language}-conventions`** skill for build, lint, and test commands.
- Run all commands from the repo checkout directory (`params.repoCheckoutDir` / workspace layout in the system prompt).
- Run the full existing test suite per the language skill.

If the build fails, stop immediately and report.

### Reading build / test output efficiently

Build and test runs typically produce kilobytes to megabytes of routine
progress with the actionable bit at the bottom. **Never `Read` the whole
output file** — pulling the full log into context bloats time-to-first-token,
which is the single biggest driver of the upstream "stream idle ≈ 5 min"
reconnects you see as **SYSTEM session started** events mid-phase. Each
reconnect burns credits without producing progress.

Default pattern: redirect once, then read only what matters via Bash.

```bash
# Capture full output for the record (cheap, runs once):
cd "$REPO" && dotnet build VLGambling.sln --no-restore 2>&1 > "$JOB_DIR/build.txt"; echo "build exit: $?"

# Then triage via Bash — never via Read on the whole file:
tail -n 200 "$JOB_DIR/build.txt"
grep -nE "(error|warning|FAIL|FAILED|Build succeeded|Tests Passed|Tests Failed)" "$JOB_DIR/build.txt" | tail -n 80
sed -n '1,30p' "$JOB_DIR/build.txt"   # if the failure is at boot, not the tail
```

Language-specific cheatsheet:

| Toolchain | First-line triage |
|---|---|
| .NET | `grep -nE "(error [A-Z]+[0-9]+|Build FAILED|Build succeeded|Tests Passed|Tests Failed)" build.txt \| tail -n 80` |
| Go | `grep -nE "(FAIL|--- FAIL|PASS\|ok\s+)" test.txt \| tail -n 80` |
| Node/npm | `grep -nE "(✖|FAIL|PASS|Tests:\s+|error TS[0-9]+)" test.txt \| tail -n 80` |
| Python/pytest | `grep -nE "(FAILED\|PASSED\|ERROR\|====+)" pytest.txt \| tail -n 80` |
| Cargo | `grep -nE "(^error|warning:|test result:)" build.txt \| tail -n 80` |

Only `Read` the whole file when it is genuinely small (under ~5 KB) or
when you need full context for a debugging step the tail/grep view
cannot show. If a grep/tail does not surface what you need, narrow the
matcher or grab a slightly bigger tail — do not fall back to a full
`Read`.

## Acceptance criteria verification

For each acceptance criterion in the job spec or implementation plan:
- Decide which tier(s) prove it (often unit + integration; sometimes
  e2e).
- Design the test cases.
- Execute them.
- Record pass/fail with details.

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
  "tiers_run": ["unit", "integration", "contract", "e2e"],
  "results": [
    {
      "test_case": "description",
      "tier": "unit|integration|contract|e2e",
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

- **Existing tests must not break** — a work item that breaks existing
  tests is not ready.
- **Build must pass** before running any tests.
- **Skipped tests need justification** — explain why each test was
  skipped.
- **Each tier owns its lane.** If you find yourself writing an E2E test
  to compensate for a missing unit / integration / contract test, fill
  the gap at the cheaper tier first.
- **Coverage is a signal, not a target.** Aim for high coverage of the
  changed surface, not absolute project coverage.
