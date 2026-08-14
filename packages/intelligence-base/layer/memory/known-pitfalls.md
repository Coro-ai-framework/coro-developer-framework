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

## Toolchain command from job working directory

**Discovered:** 2026-05-21 | **Job:** (base layer template) | **Severity:** high

Agents often run compile commands from the Coro **job root** (`working/{jobId}/`) instead of the **cloned repo subdirectory**. Symptoms include "directory prefix does not contain main module", missing `go.mod`, or git commands that touch the wrong tree.

**Key details:**
- `scm_clone_repo` lands the checkout at `params.repoCheckoutDir` under the job root.
- The system prompt and phase kickoff include a **Workspace layout** block with absolute and relative paths.

**Prevention:**
- Read the workspace block; for git use `git -C <repoCheckoutDir> …` (preferred), and run other toolchain commands with `cd <repoCheckoutDir> && …`.
- Invoke the **`{language}-conventions`** skill for build/test commands — do not invent env vars from the job root.

---

*Additional entries are added by the Evaluator via `propose_change` as jobs run.*
