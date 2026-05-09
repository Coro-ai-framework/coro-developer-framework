# Security Postures

Authn, authz, secrets handling, PII, and audit conventions per surface area
in this tenant. Read before adding any new public endpoint, message handler,
data store, or log line that could touch sensitive data.

The Evaluator or PR Reviewer populates this file via `propose_change` when a
security review surfaces a convention worth standardising. The Code
Reviewer's L4 cross-cutting lens checks new code against the entries here.

## Entry format

```
## <surface — e.g. "Public REST endpoints", "Internal gRPC", "Background workers", "Admin UI">

**Recorded:** YYYY-MM-DD | **Source job:** <job id> | **Applies to:** <repo / service / module>

### Authentication
<which mechanism is required, how to wire it, where the existing helpers live>

### Authorisation
<role / permission model, where to register a new role>

### Secrets
<where secrets come from, how to reference them, what is banned (e.g. no env-var dumps)>

### PII / sensitive data
<what counts as PII for this surface, how to redact in logs, retention rules>

### Audit
<what events must be audited, the audit-log shape, where it goes>

### Anti-patterns to reject in review
- <pattern>
- <pattern>
```

---

*No entries yet. Agents populate this file as security conventions emerge.*
