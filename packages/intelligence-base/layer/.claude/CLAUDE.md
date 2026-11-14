# Coro Agent Rules

Portable rules for every agent in this repository: behaviour, git conventions and pull-request conventions. Claude Code loads this file natively. When the Coro runner drives a job it also injects `.claude/coro/RUNTIME.md`, which holds the runner's tools, sandbox, checkpoints and self-improvement pipeline.

## Agent behavior rules

1. **Consult project memory before starting.** `.claude/memory/MEMORY.md` and the files it links hold known pitfalls, library choices and patterns learned from past work. (Coro runner sessions read them through `read_memory`.)

2. **Read conventions before writing code or opening PRs.** Follow the git conventions below and invoke the language conventions skill for the target language before writing or reviewing code.

3. **Never change an API contract without documenting it.** If a service must deviate from the source contract, document the deviation in the PR description with the reason. Never silently omit an endpoint.

4. **Scope is strict.** Only work on the repos, projects, and features specified in the job context or the user's request. Do not analyze or touch anything outside scope, even if it looks related.

5. **Never read credentials from files or log them.** Use the credentials the environment already provides, and never ask the user to paste a secret into a command, a remote URL or a file.

<!-- standalone:start -->
## Running without the Coro runner

This section applies only in a plain Claude Code (or other agent) session. The Coro runner strips it when it materialises this file, so Coro agents never see it.

**Detection.** If no `mcp__coro__*` tools are available in your session, you are standalone. The agent and workflow files in this repository are written for the Coro runner and name its tools; use the substitutions below instead of calling a tool that does not exist.

**Working directory.** The current repository is the checkout: skip any "clone the repo" step and read `repoCheckoutDir` as `.`. Put every spec, plan, report and other artefact in `.coro-work/<run-slug>/` (choose a short slug for the run, and suggest adding `.coro-work/` to `.gitignore`). Never write artefacts into tracked source directories.

**Tool substitutions.**

| Coro tool | Do this instead |
|---|---|
| `log` | Post a short progress update in chat. |
| `read_memory` | Read `.claude/memory/MEMORY.md` and the files it links, or the one file you need under `.claude/memory/`. |
| `set_work_items`, `get_work_items`, `update_work_item` | Use `TodoWrite` and mirror the list to `.coro-work/<run-slug>/work-items.json`. |
| `request_new_session`, `set_job_params` | No-op. Record the values (for example `language`) in `.coro-work/<run-slug>/params.json`. |
| `goto_phase` | State the recommended next phase in your final message; the workflow command sequences the phases. |
| `switch_workflow` | State the recommended lane (`job-fast`, `job`, `job-deep`) in your final message; the orchestrator switches to that workflow command. |
| `await_event` with `developer-input: ...` | End your turn with explicit, numbered questions. |
| `await_event` for `pr:*` events | Stop and tell the user what to re-run once the pull request is approved or merged. |
| `escalate` | Stop and report the blocker, with what you already tried. |
| `post_artifact`, `get_artifacts` | Write the file under `.coro-work/<run-slug>/` and print its path; list that directory to see earlier artefacts. |
| `add_insight` | Append an entry (category, summary, exact recipe) to `.coro-work/<run-slug>/insights.md`. |
| `propose_change`, `list_proposals` | Suggest the edit to `.claude/memory/`, a skill or an agent in your reply, and apply it only after the user approves. |
| `scm_clone_repo`, `scm_get_clone_info` | Not needed; use the current checkout. |
| other `scm_*` tools | Use plain `git`. Use `gh`, `glab` or a connected SCM MCP server only after the user approves pushing or opening a pull request. |
| `tracker_*` | Use a connected tracker MCP server if there is one; otherwise skip the ticket steps. |
| `loki_query`, `tempo_*` | Skip unless an equivalent MCP server is connected. |
| `code_review_lenses` | Ask the orchestrator to run the `review-*` agents on the diff, then `review-verifier` on what they found. |
| job-history, campaign, pull-request-review and upstream tools | Unavailable. The workflow is runner-only: say so and stop. |

**Todo tools.** The Coro runner bans `TodoWrite`; standalone it is the right tool for work items.

**Pull request descriptions.** Leave the `[PR-REVIEWER-AGENT]` line out of the template above; it is a marker for the Coro runner.

**Subagents cannot delegate or ask questions.** A Claude Code subagent cannot start other subagents or talk to the user. When your instructions say to invoke another subagent (for example the coder calling `code-reviewer`) or to ask the developer something, finish your turn, name exactly what is needed, and let the orchestrator do it.
<!-- standalone:end -->

## Git and PR conventions

### Branch naming

```
feature/{service-name}-{short-description}
fix/{service-name}-{short-description}
```

Rules:
- All lowercase, hyphens only (no underscores, no slashes beyond the prefix)
- `{service-name}` is the name of the service or repository being changed (e.g., `user-service`)
- `{short-description}` is 2-5 words describing the work

### Commit messages

Format: `{type}: {description}`

Types:
- `feat:` — New functionality
- `fix:` — Bug fix or correction to match contract
- `refactor:` — Code restructure with no behavior change
- `test:` — Test additions or changes
- `chore:` — Build, config, dependency changes

Rules:
- Lowercase, present tense: `feat: add user registration endpoint` not `Added user registration`
- Max 72 characters for the subject line
- If the commit is in response to PR feedback: `fix: address PR feedback - {brief description}`

### PR title

`[{ServiceName}] {Feature description}`

### PR description template

```markdown
## What
{1-2 sentences describing what this PR implements}

## Implementation context
- Workflow: {workflow path or job type}
- Work item: {work item name, or "N/A"}

## Behavioral deviations
{List any intended deviations, or "None"}

## Testing
{Describe how to test, or reference the acceptance criteria from the implementation plan}

## Gaps / follow-up
{Any endpoints not yet implemented, with reason, or "None"}

[PR-REVIEWER-AGENT]
```

### Merge strategy

- Squash merge to keep main branch history clean
- Squash commit message: same as PR title

### Branch lifecycle

- Branches are deleted after merge
- Never commit directly to `main` or `master`
- `main` and `master` always represents the latest merged, tested state
