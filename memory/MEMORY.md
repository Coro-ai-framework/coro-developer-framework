# Memory Index

This index is loaded automatically. Each entry points to a memory file.
Keep entries under 150 characters. Lines beyond 200 will be truncated.

## Active memories

- [Known Pitfalls](known-pitfalls.md) — Translation mistakes, serialization traps, and language-specific behaviors [migration]
- [Successful Patterns](successful-patterns.md) — Validated approaches that worked well in past jobs [general]
- [PR Feedback Patterns](pr-feedback.md) — Recurring developer feedback from code reviews [general]
- [.NET to Go Mappings](dotnet-to-go-mappings.md) — Discovered translation patterns for specific .NET constructs [migration]

## Note on memory updates

Writing to any file in this directory triggers the Agent Host's self-improvement pipeline: a PR is automatically opened on the `a5-ai` repo for human review. Memory changes only become canonical after a human approves and merges that PR.
