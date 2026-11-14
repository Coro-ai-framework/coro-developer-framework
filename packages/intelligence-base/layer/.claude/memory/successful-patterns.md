# Successful Patterns

Approaches that have been validated across migrations. Prefer these over inventing new approaches.

---

## Git push recovery for host denials

Never chain `git add` / `git commit` / `git push` in one Bash call. Commit first
with separate unchained `git -C <repoCheckoutDir> …` calls. When `git push
origin <branch>` is stopped by an unanswerable host permission prompt,
`operation not permitted`, `EPERM`, or a similar sandbox-like denial, retry
exactly once as an un-chained command:

```bash
git -C <repoCheckoutDir> push origin <branch>
```

If that retry fails, follow the sandbox-recovery skill. For local SCM (absolute
`origin` outside the job dir), the documented fallback is `pr-preview` + review
`scm_create_pr` — do not escalate. For hosted SCMs, escalate or use another
documented provider-native fallback. Do not use raw HTTP, command wrappers, or
repeated retries to bypass host policy.
