# Architecture Decisions

ADR-style records of cross-cutting architectural decisions surfaced from
DEEP-lane jobs. Read before planning any work that touches a shared
abstraction, public surface, or cross-service boundary.

The Evaluator (or PR Reviewer for systemic patterns) populates this file via
`propose_change` when a job's `working/{job-id}/design-notes.md` produces a
decision that future jobs should respect. The Planner reads this file before
writing design notes so it does not re-litigate already-settled decisions.

## Entry format

```
## ADR-NNN: <one-line title>

**Decided:** YYYY-MM-DD | **Source job:** <job id> | **Status:** accepted | superseded by ADR-NNN | deprecated

### Context
<1–3 paragraphs describing the forces in play>

### Decision
<the choice, in one paragraph>

### Consequences
- <trade-off accepted>
- <constraint imposed on future work>

### When to revisit
<concrete conditions that should trigger a new ADR>
```

---

*No entries yet. The Evaluator will populate this file as DEEP-lane jobs run.*
