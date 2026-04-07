# Migration Evaluation Guide

Domain-specific guidance for evaluating migration test results. Supplements the generic Evaluator agent instructions with migration-specific failure taxonomy and diagnosis techniques.

## Root cause taxonomy

When triaging test failures from comparison testing, classify each failure's root cause:

| Root Cause Category | Description |
|--------------------|-------------|
| `serialization` | JSON field name, type, or format mismatch between source and migrated service |
| `validation` | Validation logic doesn't match source behavior (different error shape, wrong fields rejected) |
| `missing-endpoint` | Endpoint exists in contract but not in migrated service |
| `auth` | Auth check is wrong (too strict, too loose, wrong claims) |
| `business-logic` | The handler returns wrong values or wrong status codes |
| `dependency` | An external call (DB, HTTP) is failing or returning wrong data |
| `config` | Missing or wrong environment variable / connection string |
| `test-artifact` | The test itself is wrong (wrong payload, wrong expectation) |

## Diagnosis procedure

For each failed test case:

1. Read the diff carefully — what exactly differs?
2. Look up the endpoint and its contract in `service-contract.json`
3. Look at the migrated source code for that handler
4. Classify using the taxonomy above
5. Check if this is a known pitfall from `memory/known-pitfalls.md`

## Known pitfall detection

If the root cause matches a known pitfall from memory:
- Note that the coder failed to apply a known rule
- Consider whether the agent instructions need strengthening for this rule
- Flag this as a process gap, not just a code gap

## Common migration-specific failures

### Serialization mismatches
- JSON property names not matching `[JsonProperty]` overrides
- Null handling differences (included vs omitted)
- DateTime format differences (ISO 8601 vs custom formats)
- Enum serialization (string vs integer)
- TimeSpan/Duration format (ISO 8601 `PT1H30M` vs ticks vs custom)

### Validation divergence
- .NET auto-validates models before the action runs — missing explicit validation in target
- Different validation error response shape (`ValidationProblemDetails` vs custom)
- Required field handling differences

### Error response shape
- `ProblemDetails` format differences (missing `type`, `title`, `detail` fields)
- Different status code for the same error condition
- Missing global error handler in migrated service

## Decision criteria

### Loop back to coder if:
- Any `contract-violation` failures exist
- Any `missing-endpoint` failures exist
- Any `auth` failures that would cause clients to get 401/403 unexpectedly

### Declare feature complete if:
- Zero `contract-violation` failures
- Zero `missing-endpoint` failures
- Zero `auth` failures
- Remaining failures are only `behavior-drift` (documented/accepted), `performance` (noted), or `skipped` (explained)

## Memory update templates

### New pitfall entry
```markdown
## Pitfall: {short title}
- **Symptom:** What the test diff showed
- **Root cause:** Why it happened
- **Fix:** The correct implementation in target language
- **Applies to:** (serialization / auth / validation / etc.)
- **Discovered:** {date}
```

### New translation mapping
```markdown
## {Source concept} → {Target equivalent}
- **Context:** When this applies
- **Example:** Source code vs target code
- **Gotchas:** Any edge cases
```
