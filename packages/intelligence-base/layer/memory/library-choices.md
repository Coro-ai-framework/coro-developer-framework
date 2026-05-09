# Library Choices

Approved and discouraged third-party dependencies for this tenant, with
rationale. Read before adding a new dependency, swapping one out, or major-
version-bumping an existing one.

The Evaluator populates this file via `propose_change` when a job's
dependency choice (or removal) is worth standardising. The Code Reviewer's
L4 cross-cutting lens checks new dependencies against this file.

## Entry format

```
## <library name> (<ecosystem>)

**Status:** preferred | acceptable | discouraged | banned
**Recorded:** YYYY-MM-DD | **Source job:** <job id> | **Applies to:** <language / framework / surface>

### Use for
<the cases this library is the right tool for>

### Don't use for
<cases where a different library is preferred — link to its entry>

### Rationale
<one paragraph: why this status>

### Alternatives
- <library X — when to prefer it>
- <library Y — when to prefer it>

### Migration notes (only when status is discouraged | banned)
<how to replace existing usages safely>
```

---

*No entries yet. The Evaluator populates this file as patterns emerge.*
