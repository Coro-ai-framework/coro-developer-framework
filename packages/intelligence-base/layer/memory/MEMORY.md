# Memory Index

This index is loaded automatically. Each entry points to a memory file.
Keep entries under 150 characters. Lines beyond 200 will be truncated.

## Active memories

- [Known Pitfalls](known-pitfalls.md) — Recurring failure patterns to avoid [general]
- [Successful Patterns](successful-patterns.md) — Validated approaches that worked well in past jobs [general]
- [PR Feedback Patterns](pr-feedback.md) — Recurring developer feedback from code reviews [general]

## Note on memory updates

Writing to any file in this directory triggers the runner's self-improvement
pipeline: a PR is automatically opened on the intelligence repo for human
review. Memory changes only become canonical after a human approves and
merges that PR.

## Tenant overrides

Tenant overlays may add their own memory files (e.g. company-specific
pitfalls, language migration patterns, organisational conventions). Add an
entry here when you do — agents read this index first to discover what's
available.
