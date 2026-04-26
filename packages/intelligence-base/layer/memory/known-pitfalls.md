# Known Pitfalls

Patterns that have caused failures in past runs against this tenant. Read
before writing any code.

The Evaluator agent populates this file via `propose_change` when it
identifies a recurring failure pattern that future jobs should avoid.

## Entry format

```
## <one-line title that captures the failure>

**Discovered:** YYYY-MM-DD | **Job:** <job id or short label> | **Severity:** low|medium|high

<1–3 paragraphs describing what happened and why>

**Key details:**
- <fact 1>
- <fact 2>

**Prevention:**
<concrete mitigation: a check, a tool to call, a convention to follow>
```

---

*No entries yet. The Evaluator will populate this file as jobs run.*
