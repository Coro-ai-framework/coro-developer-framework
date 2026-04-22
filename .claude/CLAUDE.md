# A5 Agent Runtime Instructions

This file is loaded automatically by the Agent SDK via `settingSources: ['project']`. Every agent in every workflow receives this context.

## Design philosophy

**TypeScript = dumb tool shell.** It runs phases linearly, provides MCP tools, persists state in Redis, and parks/resumes on webhooks. It has zero orchestration intelligence.

**Intelligence = MD files + LLM judgment.** Workflow markdown defines phases and metadata. Agent markdown defines procedures. The LLM reads artifacts, calls tools to update state, and uses `goto_phase` to control flow. The evaluator decides when to loop. The planner decides how many features. The coder decides when it needs a fresh session.

## Agent behavior rules

1. **Load memory on demand via `read_memory`.** Memory is NOT pre-loaded into your system prompt. At the start of a job (or whenever you need to check prior learnings, known pitfalls, conventions, or pending proposals), call `mcp__a5__read_memory` with no arguments — it returns the index, every linked file, and any pending on-disk proposals. For a single file, pass `{ file: "known-pitfalls.md" }`.

2. **Read conventions before writing code or opening PRs.** Follow the git conventions below and invoke the language conventions skill for the target language before writing or reviewing code.

3. **Use the `log` tool constantly.** Developers watch job progress via `a5 logs`. Log every significant action, decision, and result — not just errors. Be specific: `"Extracted 14 endpoints from UserController"` not `"Analyzed code"`.

4. **Never skip a workflow step silently.** If a step cannot be completed, call `escalate` with a precise description of the blocker. Do not invent a workaround that deviates from the workflow.

5. **Never change an API contract without documenting it.** If a service must deviate from the source contract, document the deviation in the PR description with the reason. Never silently omit an endpoint.

6. **Record insights when you learn something reusable.** A failure pattern, a workaround, a translation rule, an auth quirk — if it will help future runs, call `add_insight` with the category, a one-line summary, and full context. The Evaluator reviews all insights at the end and decides what to propose via `propose_change`. `propose_change` is enforced by a runtime hook to only work during the `evaluation` phase — calls from any other phase are denied. Use `add_insight` everywhere else and let the evaluator decide.

7. **Prefer observed behavior over code analysis.** When a service's behavior is ambiguous, call `loki_query` to check actual production traffic before assuming. Code can lie; logs don't.

8. **Scope is strict.** Only work on the repos, projects, and features specified in the job context. Do not analyze or touch anything outside scope, even if it looks related.

9. **Credentials are never read from files.** They are injected by the Agent Host as environment variables and available in the job context. Never ask for or log credentials.

10. **Use feature tracking tools for multi-feature jobs.** Call `get_features` to check progress, `update_feature` to update status, `set_features` to register the feature list, and `request_new_session` when starting a new feature.

11. **Do not manually park normal workflow checkpoints.** If a phase is marked `interactive_checkpoint: true` and the workflow docs say the runner enforces it, finish the phase normally and let the runner park for approval. Use `await_event({ eventName: "developer-input: <reason>" })` only for extra mid-phase questions, clarifications, or external waits the runner cannot infer.

## Company context

- **Company:** A5 Labs
- **Primary stack:** .NET 8 microservices (C#), migrating to Go
- **Source control:** BitBucket or GitHub — the job's `params.gitProvider` field specifies which provider hosts the target repository. Default: `bitbucket`. BitBucket workspace slug is in `config/credentials.md`.
- **Observability:** Grafana — Loki (logs) + Tempo (distributed traces)
- **Deployment:** Kubernetes via Helm. Per-service config in `helm-app-config` repo (see `config/repos.md`)
- **Environments:** staging and production. Staging is the benchmark for all migration testing.
- **Issue tracking:** Jira (future integration — Jira-triggered feature jobs)

## Service accounts

### BitBucket

| Account | BB role | Used for |
|---------|---------|---------|
| `@a5-coder-agent` | Developer on all service repos and `a5-ai` | Creating repos, branches, commits, opening PRs, responding to review comments |
| `@a5-reviewer-agent` | Reviewer/Maintainer on all service repos and `a5-ai` | Posting code reviews, approving PRs, triggering merges, monitoring comment threads |

### GitHub

GitHub operations use a Personal Access Token (PAT) configured via `GH_TOKEN`. The token must have **Contents** (read/write), **Pull requests** (read/write), and **Metadata** (read) permissions on the target repos.

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
- `goto_phase` — Override the next phase (e.g., loop back to coding, or jump over phases). If you do not call `goto_phase`, the runner auto-advances to the next phase when your turn ends. There is no separate "complete this phase" tool — simply finish your work and end your turn.
- `await_event` — Park the job waiting for an external event. Two main uses:
  - `await_event({ eventName: "pr:merged", prId })` for PR-driven waits.
  - `await_event({ eventName: "developer-input: <short reason>" })` whenever you need a human to clarify, choose between options, confirm an ambiguous point, or provide information mid-phase. Use this for additional developer input, not for normal workflow checkpoints that the runner already enforces.
- `escalate` — Escalate to human when you cannot self-resolve (not a substitute for `await_event`).
- `log` — Append to the job log stream.

### On-demand context
- `read_memory` — Load accumulated memory (pitfalls, patterns, conventions) plus any pending self-improvement proposals. No args: full bundle. `{ file }`: a single file. The system prompt no longer carries memory by default — call this yourself.

### BitBucket (use when `params.gitProvider` is `bitbucket` or unset)
- `bb_create_repo` — Create a new private BitBucket repository
- `bb_create_pr` — Open a pull request from a feature branch (registers with job system for webhook routing)
- `bb_get_pr_status` — Get the current state and approval count of a PR
- `bb_get_pr_comments` — List all comments on a pull request
- `bb_post_pr_comment` — Post a new top-level comment on a PR
- `bb_reply_to_comment` — Reply to an existing comment thread on a PR
- `bb_approve_pr` — Approve a pull request
- `bb_merge_pr` — Merge a pull request (only when approved and all comments resolved)

### GitHub (use when `params.gitProvider` is `github`)
- `gh_create_repo` — Create a new private GitHub repository
- `gh_create_pr` — Open a pull request from a feature branch (registers with job system)
- `gh_get_pr_status` — Get the current state and approval count of a PR
- `gh_get_pr_comments` — List all comments on a pull request
- `gh_post_pr_comment` — Post a new top-level comment on a PR
- `gh_reply_to_comment` — Reply to an existing review comment on a PR
- `gh_approve_pr` — Approve a pull request
- `gh_merge_pr` — Merge a pull request (squash merge)

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

### Artefacts
- `post_artifact` — Record an artefact produced by your phase so developers can view it from the dashboard. Arguments: `{ kind, title, data, phase? }`. `phase` defaults to your current phase. See "Artefacts" section below for kinds and data shapes.
- `get_artifacts` — List artefacts already posted on the job, optionally filtered by phase.

## Artefacts — what to record for each phase

After you produce output that is useful to a developer (plan, PR, report, test results, contract file), call `post_artifact` with a `kind` and the minimum data needed for the dashboard to render it. Artefacts are free-form JSON objects — the dashboard decides how to display each `kind`.

Rules:
- **Post artefacts as you create them**, not at the end of the phase. If you open a PR mid-phase, post the `pr-link` artefact immediately so developers can see it.
- **Paths must be relative to the working directory** (`working/{job-id}/...`). Never post absolute paths — they won't be readable by the dashboard.
- **One artefact per output**. If you produce a plan file AND a contract file, post two separate artefacts.
- **Pick an existing `kind` when one fits**. Only invent a new kind if nothing below matches — the dashboard falls back to a JSON viewer for unknown kinds.

Common kinds:

| kind | When | Data shape |
|---|---|---|
| `plan-md` | Planner writes a migration or feature plan | `{ path: "…/migration-plan.md" }` |
| `implementation-plan-md` | Planner writes an implementation plan for a feature | `{ path: "…/implementation-plan.md" }` |
| `analysis-contract` | Analyzer writes the service contract JSON | `{ path: "…/service-contract.json" }` |
| `pr-link` | Coder opens a PR (both bb and gh paths) | `{ url, prId, repoSlug, title }` |
| `review-summary` | PR Reviewer posts a review summary | `{ prId, repoSlug, verdict, summary }` |
| `test-results` | Tester finishes running the comparison suite | `{ path, passed, failed, skipped }` |
| `evaluation-md` | Evaluator writes an evaluation report | `{ path: "…/evaluation.md" }` |
| `report-md` | Any agent writes a human-readable report | `{ path: "…/report.md" }` |
| `url` | Any external link that doesn't fit above | `{ url, label }` |

Example:
```
post_artifact({
  kind: "plan-md",
  title: "Migration plan for user-service",
  data: { path: "user-service/migration-plan.md" }
})
```

## Interactive mode

Phases flagged `interactive_checkpoint: true` are enforced by the runner when `job.interactive` is `true`. Finish the phase normally; the runner will park for developer approval before advancing.

Use `await_event({ eventName: "developer-input: <short reason>" })` only when you need additional developer input that is not the standard workflow checkpoint, for example:

- an ambiguous spec or requirement
- a design tradeoff that needs a human choice
- missing repo/provider/environment information
- an external action the developer must take before you can continue

The `developer-input:` prefix is recognised by the runner and parks the job with status `awaiting-developer-input`.

### When to park explicitly

If the workflow docs say a phase checkpoint is runner-enforced, do **not** call `await_event` just to request the normal approval for that phase. Finish the phase and let the runner park automatically.

Call `await_event` explicitly only for additional mid-phase questions or for non-checkpoint waits that the runner cannot infer. Prefer `await_event` over `escalate` when a human response would let you continue; reserve `escalate` for true blockers.

### Resume prompt format

When the developer sends a message, you are resumed with a framed prompt starting with `[DEVELOPER RESPONSE]`. It tells you:

- The phase you were paused during.
- What you were waiting for (the reason string you passed to `await_event`).
- The artefacts you posted that phase.
- The developer's verbatim message.

Based on the message:
- **Approval** ("go ahead", "looks good", "continue") → finish your turn. The runner auto-advances to the next workflow phase. If you want to jump somewhere non-default, call `goto_phase` before ending.
- **Rework** ("add X", "rename Y", "fix Z first") → do the work in the **current** phase, post any updated artefacts, then either (a) call `await_event` again if you still need re-approval, or (b) end your turn / call `goto_phase` to move on.
- **Ambiguous** → make your best interpretation and explain in `log` what you're about to do. Do not re-park just to re-ask — the developer has already spoken.

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

This is enforced at runtime: a `PreToolUse` hook denies any `Write` or `Edit` that resolves outside your working directory. The only other write-allowed location is `<a5-ai>/memory/` — used when the evaluator's `propose_change` writes a proposal file. Any other path will be denied with a clear error message.

Rules:
- **Never `cd` above your working directory.** Do not navigate to parent directories, the user's home directory, or any path outside `$PWD`.
- **Clone repos into the current directory**, not into a subdirectory like `working/{job-id}/`. You are already inside that directory. Example: `git clone "$CLONE_URL" repo-slug` creates `./repo-slug/` in your cwd.
- **Use relative paths** for all file operations. Do not construct absolute paths unless using `$PWD` as the base.
- **Write all output files** (plans, contracts, test results, evaluation reports) inside the current working directory.
- This constraint exists because the Agent Host may run inside Docker where paths outside the working directory do not exist.

## Infrastructure

Repositories may live on **BitBucket** or **GitHub**. Check `params.gitProvider` in the job context to determine which provider hosts the target repo.

### BitBucket environment variables (available when BitBucket is configured)
```
BB_WORKSPACE          — BitBucket workspace slug
BB_GIT_USERNAME       — git username (x-token-auth for API tokens, or encoded username)
BB_CODER_APP_PASSWORD — API token for git operations
BB_BASE_URL           — https://bitbucket.org
```

To clone a **BitBucket** repo:
```bash
git clone "https://$BB_GIT_USERNAME:$BB_CODER_APP_PASSWORD@bitbucket.org/$BB_WORKSPACE/<repo-slug>.git"
```

### GitHub environment variables (available when GitHub is configured)
```
GH_OWNER              — GitHub user or organization that owns the repo
GH_TOKEN              — GitHub Personal Access Token
```

To clone a **GitHub** repo:
```bash
git clone "https://x-access-token:$GH_TOKEN@github.com/$GH_OWNER/<repo-slug>.git"
```

### Choosing the right tools

**Check `params.gitProvider`** in your job context before cloning or using PR tools:
- If `gitProvider` is `github` → use `git clone` with the GitHub URL and `gh_*` MCP tools (`gh_create_pr`, `gh_get_pr_comments`, etc.)
- If `gitProvider` is `bitbucket` or not set → use `git clone` with the BitBucket URL and `bb_*` MCP tools (`bb_create_pr`, `bb_get_pr_comments`, etc.)

**Never use `gh` CLI commands.** Always use `git` directly with the appropriate URL and MCP tools for PR operations.

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
