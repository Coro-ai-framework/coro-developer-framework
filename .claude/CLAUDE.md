# A5 Agent Runtime Instructions

This file is loaded automatically by the Agent SDK via `settingSources: ['project']`. Every agent in every workflow receives this context.

## Design philosophy

**TypeScript = dumb tool shell.** It runs phases linearly, provides MCP tools, persists state in Redis, and parks/resumes on webhooks. It has zero orchestration intelligence.

**Intelligence = MD files + LLM judgment.** Workflow markdown defines phases and metadata. Agent markdown defines procedures. The LLM reads artifacts, calls tools to update state, and uses `goto_phase` to control flow. The evaluator decides when to loop. The planner decides how many features. The coder decides when it needs a fresh session.

## Agent behavior rules

1. **Read memory before doing anything.** Read `memory/MEMORY.md` and every file it references. Memory contains hard-won knowledge from past runs. Do not repeat known mistakes.

2. **Read conventions before writing code or opening PRs.** Follow the git conventions below and invoke the language conventions skill for the target language before writing or reviewing code.

3. **Use the `log` tool constantly.** Developers watch job progress via `a5 logs`. Log every significant action, decision, and result — not just errors. Be specific: `"Extracted 14 endpoints from UserController"` not `"Analyzed code"`.

4. **Never skip a workflow step silently.** If a step cannot be completed, call `escalate` with a precise description of the blocker. Do not invent a workaround that deviates from the workflow.

5. **Never change an API contract without documenting it.** If a service must deviate from the source contract, document the deviation in the PR description with the reason. Never silently omit an endpoint.

6. **Record insights when you learn something reusable.** A failure pattern, a workaround, a translation rule, an auth quirk — if it will help future runs, call `add_insight` with the category, a one-line summary, and full context. The Evaluator reviews all insights at the end and decides what to propose via `propose_change`. Do not call `propose_change` directly unless you are the Evaluator or PR Reviewer agent.

7. **Prefer observed behavior over code analysis.** When a service's behavior is ambiguous, call `loki_query` to check actual production traffic before assuming. Code can lie; logs don't.

8. **Scope is strict.** Only work on the repos, projects, and features specified in the job context. Do not analyze or touch anything outside scope, even if it looks related.

9. **Credentials are never read from files.** They are injected by the Agent Host as environment variables and available in the job context. Never ask for or log credentials.

10. **Use feature tracking tools for multi-feature jobs.** Call `get_features` to check progress, `update_feature` to update status, `set_features` to register the feature list, and `request_new_session` when starting a new feature.

## Company context

- **Company:** A5 Labs
- **Primary stack:** .NET 8 microservices (C#), migrating to Go
- **Source control:** BitBucket (workspace slug in `config/credentials.md`)
- **Observability:** Grafana — Loki (logs) + Tempo (distributed traces)
- **Deployment:** Kubernetes via Helm. Per-service config in `helm-app-config` repo (see `config/repos.md`)
- **Environments:** staging and production. Staging is the benchmark for all migration testing.
- **Issue tracking:** Jira (future integration — Jira-triggered feature jobs)

## BitBucket service accounts

| Account | BB role | Used for |
|---------|---------|---------|
| `@a5-coder-agent` | Developer on all service repos and `a5-ai` | Creating repos, branches, commits, opening PRs, responding to review comments |
| `@a5-reviewer-agent` | Reviewer/Maintainer on all service repos and `a5-ai` | Posting code reviews, approving PRs, triggering merges, monitoring comment threads |

Human developers interact with these accounts exactly as they would with a human colleague — comments appear in PRs, review requests arrive normally.

## MCP tools available to agents

All MCP tools are prefixed with `mcp__a5__` when calling them (e.g., `mcp__a5__log`, `mcp__a5__bb_create_pr`). **Do NOT use `ToolSearch` to discover these tools — the complete list is below.** If a tool call fails, check the name and parameters rather than searching for it.

### Feature tracking
- `set_features` — Register the ordered feature list (called by planner)
- `update_feature` — Update a feature's status or increment its loop count
- `get_features` — Read the current feature list with statuses
- `request_new_session` — Clear session for fresh context (e.g., new feature)
- `set_job_params` — Set dynamic job parameters (e.g., language)

### Job control
- `mark_phase_complete` — Optional early turn end
- `goto_phase` — Override next phase (e.g., loop back to coding)
- `await_event` — Park job waiting for external event
- `escalate` — Escalate to human
- `log` — Append to job log stream

### BitBucket — coder account
- `bb_create_repo` — Create a new private BitBucket repository
- `bb_create_pr` — Open a pull request from a feature branch (registers with job system for webhook routing)

### BitBucket — reviewer account
- `bb_get_pr_status` — Get the current state and approval count of a PR
- `bb_get_pr_comments` — List all comments on a pull request
- `bb_post_pr_comment` — Post a new top-level comment on a PR
- `bb_reply_to_comment` — Reply to an existing comment thread on a PR
- `bb_approve_pr` — Approve a pull request
- `bb_merge_pr` — Merge a pull request (only when approved and all comments resolved)

### Test harness
- `run_go_build` — Compile a Go project in a directory
- `start_go_service` — Start a compiled Go binary in the background on a given port
- `stop_go_service` — Stop a running Go service by label
- `compare_request` — Send the same HTTP request to both Go and .NET services, then diff responses

### Observability
- `loki_query` — Run a LogQL query against Loki
- `tempo_get_trace` — Fetch a full distributed trace by trace ID from Tempo
- `tempo_search` — Search for traces matching a TraceQL query

### Jira
- `jira_get_issue` — Fetch a Jira issue by ticket ID
- `jira_post_comment` — Post a comment on a Jira issue
- `jira_transition_issue` — Move a Jira issue to a new status

### Self-improvement
- `add_insight` — Record a learning, workaround, or pattern for the Evaluator to review (all agents)
- `propose_change` — Propose an improvement to agents, skills, memory, or code (Evaluator / PR Reviewer only)
- `list_proposals` — Check past proposals before proposing duplicates

## Banned tools — do NOT use

- **`TodoWrite` / `TodoRead`** — Do NOT use the built-in todo tool. Use `mcp__a5__log` to report progress instead. The todo tool is a local scratch pad that no one monitors. Developers follow your work via `a5 logs`, which reads from `mcp__a5__log`.
- **`ToolSearch`** — Do NOT use ToolSearch to discover MCP tools. The complete tool list is documented above. If a tool call fails, verify the tool name and parameters.

## Self-improvement rule

When any agent calls `propose_change`, the Agent Host file watcher detects the written files and automatically:

1. Validates the proposal (TypeScript build, YAML parse, workflow config parse, skill frontmatter)
2. Creates a branch in this repo: `improvement/{short-description}`
3. Commits the changed files
4. Opens a PR tagged with the human developers and `@a5-reviewer-agent`
5. Labels the PR `agent-self-improvement`

**Agent knowledge improvements are always reviewed by humans before becoming canonical.** No agent can silently modify how other agents behave. Once the PR merges, the Agent Host pulls the latest `a5-ai` and all subsequent job phases use the updated instructions immediately.

## Working directory

The Agent Host sets your current working directory (`cwd`) to `working/{job-id}/` before each phase starts. **This is your sandbox. All file operations must happen inside this directory.**

Rules:
- **Never `cd` above your working directory.** Do not navigate to parent directories, the user's home directory, or any path outside `$PWD`.
- **Clone repos into the current directory**, not into a subdirectory like `working/{job-id}/`. You are already inside that directory. Example: `git clone "$CLONE_URL" repo-slug` creates `./repo-slug/` in your cwd.
- **Use relative paths** for all file operations. Do not construct absolute paths unless using `$PWD` as the base.
- **Write all output files** (plans, contracts, test results, evaluation reports) inside the current working directory.
- This constraint exists because the Agent Host may run inside Docker where paths outside the working directory do not exist.

## Infrastructure

All source repositories live on **BitBucket**, not GitHub.

These environment variables are already set in your shell:
```
BB_WORKSPACE          — BitBucket workspace slug
BB_GIT_USERNAME       — git username (x-token-auth for API tokens, or encoded username)
BB_CODER_APP_PASSWORD — API token for git operations
BB_BASE_URL           — https://bitbucket.org
```

To clone a repo into the current working directory:
```bash
git clone "https://$BB_GIT_USERNAME:$BB_CODER_APP_PASSWORD@bitbucket.org/$BB_WORKSPACE/<repo-slug>.git"
```

This creates `./<repo-slug>/` in your current directory. Do NOT specify a different target path.

**Never use `gh`, `hub`, or GitHub CLI commands. Always use `git` directly with the BitBucket URL above.**

## Git and PR conventions

### Branch naming

```
feature/{service-name}-{short-description}
fix/{service-name}-{short-description}
```

Rules:
- All lowercase, hyphens only (no underscores, no slashes beyond the prefix)
- `{service-name}` is the Go service name (e.g., `user-service-go`)
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

## Migration context
- Feature: {feature name from migration plan}
- Endpoints implemented:
  - METHOD /path/one
  - METHOD /path/two

## Deviations from .NET contract
{List any deviations, or "None"}

## Testing
{Describe how to test, or reference the acceptance criteria from the migration plan}

## Gaps / follow-up
{Any endpoints not yet implemented, with reason, or "None"}

[PR-REVIEWER-AGENT]
```

### PR review process

1. Coder opens PR and tags human reviewers + includes `[PR-REVIEWER-AGENT]`
2. PR Reviewer agent performs initial automated review
3. Human reviewers comment, approve, or request changes
4. Coder responds to all change requests
5. PR Reviewer agent verifies resolution and confirms via comment
6. At least one human approval required before merge
7. PR Reviewer agent triggers merge after human approval

### Merge strategy

- Squash merge to keep main branch history clean
- Squash commit message: same as PR title

### Branch lifecycle

- Branches are deleted after merge
- Never commit directly to `main` or `master`
- `main` and `master` always represents the latest merged, tested state
