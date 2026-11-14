# Agent instructions

This repository carries the Coro intelligence layer in Claude Code's native layout under `.claude/`. Any coding agent that reads `AGENTS.md` should work from it, with or without the Coro runner.

1. Read `.claude/CLAUDE.md` first. It holds the behaviour rules, the git and pull-request conventions, and "Running without the Coro runner": how to substitute the runner's tools when they are not available.
2. Skills live in `.claude/skills/<name>/SKILL.md`: domain knowledge and language conventions. Open the one that matches your task (for example `golang-conventions`) before you write or review code.
3. Roles live in `.claude/agents/<name>.md`: one procedure per role (spec-writer, planner, coder, code-reviewer, evaluator, ...). Delegate to them as subagents where your tool supports it; otherwise read the file and follow it yourself.
4. Workflows live in `.claude/commands/coro/<name>.md`: ordered phases that chain the roles (`job`, `job-fast`, `job-deep`). Follow the "Run this workflow in Claude Code" section of the file. In Claude Code, run one as a slash command: `/coro:job <request>`, `/coro:job-fast <request>` or `/coro:job-deep <request>`.
5. Project memory lives in `.claude/memory/`. Start from `.claude/memory/MEMORY.md`: it indexes known pitfalls, library choices and patterns. Read it before you start.

Workflows that say they need the Coro runner (`campaign`, `pr-review`, `retrospective`, `self-update`, `memory-curator`, `oss-contribution`) cannot run in a plain session; tell the user to start them from the Coro dashboard or CLI.

Write specs, plans and reports to `.coro-work/<run-slug>/`, not into source directories.
