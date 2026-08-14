# Successful Patterns

Approaches that have been validated across migrations. Prefer these over inventing new approaches.

---

## Git push recovery for host denials

When `git push origin <branch>` is stopped by an unanswerable host permission prompt, `operation not permitted`, `EPERM`, or a similar sandbox-like denial, retry exactly once as an un-chained command:

```bash
git -C <repoCheckoutDir> push origin <branch>
```

If that retry fails, follow the sandbox-recovery skill and escalate or use a documented provider-native SCM fallback. Do not use raw HTTP, command wrappers, or repeated retries to bypass host policy.
