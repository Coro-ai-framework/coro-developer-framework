# Migration Report: {Service Name}

**Generated:** {date}
**Workflow run:** `working/{service-name}/`
**Go repository:** `bitbucket.org/a5labs/{service-name}-go`
**Original .NET repository:** `bitbucket.org/a5labs/{original-slug}`

---

## Summary

| Metric | Value |
|--------|-------|
| Total endpoints | N |
| Fully migrated | N |
| Migrated with documented deviation | N |
| Escalated (requires human review) | N |
| Total PRs merged | N |
| Total test cases | N |
| Test pass rate | N% |

---

## Endpoint Migration Status

| Method | Path | Status | Notes |
|--------|------|--------|-------|
| GET | /example | migrated | |
| POST | /example | with-deviation | See deviation #1 |
| DELETE | /example/{id} | escalated | See escalation #1 |

**Status definitions:**
- `migrated` — Behavior is identical to .NET service; all tests pass
- `with-deviation` — Minor documented difference; clients are not affected or difference is accepted
- `escalated` — Could not achieve full parity; human review required before cutover

---

## Documented Deviations

### Deviation 1: {title}
- **Endpoint:** METHOD /path
- **Description:** What differs from .NET behavior
- **Reason:** Why this deviation exists
- **Client impact:** None / Minimal / Requires client update
- **Accepted by:** {reviewer name + date}

---

## Escalations

### Escalation 1: {title}
- **Endpoint:** METHOD /path
- **Description:** What could not be resolved
- **Attempts:** N loops
- **Last evaluator diagnosis:** {summary}
- **Recommended action:** {what a human developer should do}

---

## Knowledge Generated

New entries added to the memory system during this migration:

| Memory file | Entry | Type |
|-------------|-------|------|
| memory/known-pitfalls.md | TimeSpan serialization | pitfall |
| memory/dotnet-to-go-mappings.md | IActionResult → http.ResponseWriter | mapping |

---

## Cutover Validation Guide

Before switching the load balancer:

### Pre-cutover checklist
- [ ] All `migrated` and `with-deviation` endpoints confirmed passing in staging
- [ ] Escalated endpoints reviewed and accepted by tech lead
- [ ] Go service deployed to staging Kubernetes cluster
- [ ] Environment variables confirmed loaded from helm-app-config
- [ ] Health endpoint `GET /health` returns 200
- [ ] Smoke test suite executed manually (see below)

### Smoke test suite

Minimal set of real requests to run immediately after cutover to confirm the service is live:

```
# Health check
GET /health → 200

# {Add endpoint-specific smoke tests here based on highest-traffic endpoints}
```

### Rollback procedure

If issues are detected post-cutover:
1. Switch load balancer back to .NET service immediately
2. The .NET service remains unchanged and can be re-activated at any time
3. Capture the failing requests from Loki for the Go service
4. File findings to `working/{service-name}/errors.md` and re-run the fix loop

---

## PRs and Review History

| PR | Feature | Merged | Reviewer(s) | Loops |
|----|---------|--------|-------------|-------|
| #1 | Infrastructure scaffolding | {date} | @alice, @bob | 0 |
