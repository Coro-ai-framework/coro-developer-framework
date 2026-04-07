# Migration Testing Guide

Domain-specific guidance for testing migrated services against the source implementation. Supplements the generic Tester agent instructions with comparison testing methodology.

## Core approach: parallel comparison testing

Migration testing is fundamentally different from feature testing. The goal is to prove behavioral equivalence between the migrated service and the source service running in staging.

## Test execution flow

1. Build and run the migrated service locally against staging dependencies
2. Load config from `helm-app-config/staging/{service-name}/values.yaml` as env vars
3. Build the service — if this fails, stop and report immediately
4. Start the service on a local port
5. Hit `GET /health` — if this fails, stop and report

## Comparison test generation

For each endpoint in the feature:

### Test cases to generate
- **Happy path:** Use real payloads from `traffic-baseline.json` if available, otherwise construct minimal valid payloads
- **Validation failures:** Missing required fields, out-of-range values, wrong types
- **Auth failures:** Missing token, invalid token, insufficient permissions
- **Not found:** Request a resource that doesn't exist
- **Edge cases:** Any unusual inputs observed in Loki traffic

### Execution
For each test case:
1. Send identical request to both the migrated service (local) and the source staging service
2. Compare:
   - **Status code:** Must be identical
   - **Response body:** Deep equality on JSON structure and values (modulo non-deterministic fields)
   - **Response headers:** Check Content-Type, any custom headers defined in the contract
   - **Response time:** Flag if migrated service is >2x slower (not a failure, but noted)

## Non-deterministic field exclusion

These fields are expected to differ between source and migrated services and must be excluded from body diffs:
- Timestamps (created_at, updated_at, etc.)
- Generated IDs (UUIDs, auto-increment IDs)
- Trace IDs and correlation IDs
- Server-specific headers (Server, X-Powered-By)

## Severity classification

| Severity | Definition |
|----------|-----------|
| `contract-violation` | Status code differs, or a field present in source response is missing from migrated response, or field type differs |
| `behavior-drift` | Response body differs in values (not structure), e.g., different default values, different formatting |
| `performance` | Migrated service response time >2x source for same request |
| `skipped` | Could not generate a valid test case (e.g., requires downstream data not available in staging) |

## Post-test Loki check

After running the test suite:
- Query Loki for any errors logged by the migrated service during the test run
- Any logged errors that didn't surface as test failures are additional findings

## Important rules

- **Never modify the source staging service** — it is the reference implementation, treat it as read-only
- **Use staging, not production** for all comparisons
- **Skipped tests are not passing tests** — if more than 20% of test cases are skipped, flag this in the summary and explain why
