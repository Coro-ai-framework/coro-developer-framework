# Deprecated Paths

APIs, modules, configs, and patterns the codebase is migrating away from.
Read before extending any subsystem — the path you're about to add to may
be on its way out, and the right move is to use the replacement.

The Evaluator or PR Reviewer populates this file via `propose_change` when a
deprecation is announced or when a migration target is named in a design
note. The Coder reads this file before adding new usages of any subsystem.

## Entry format

```
## <deprecated thing — package, module, function, config, pattern>

**Deprecated:** YYYY-MM-DD | **Removal target:** YYYY-MM-DD | <unscheduled> | **Source:** <job id or PR>

### What it was
<one paragraph: what this is and what it did>

### What replaced it
<the new path — link to docs, ADR, or library-choices.md entry>

### Migration recipe
1. <step>
2. <step>

### Status
- New code: **must not** use this.
- Existing usages: <count or "tracked in <ticket>"> remaining; migrate when touching nearby code.
```

---

*No entries yet. Agents populate this file as deprecations are recorded.*
