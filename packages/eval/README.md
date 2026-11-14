# @coro-ai/eval

A local evaluation harness for Coro. It dispatches Coro jobs against fixed
sandbox tasks, plays the human reviewer, grades what each job delivered, and
keeps every run as plain files so runs can be compared over time.

It is a **black box** around Coro. It starts the runner through the CLI and
controls it over HTTP; the only thing it imports from this repo is *types* from
`@coro-ai/cloud-protocol`. Nothing in the runner, dashboard, or intelligence
layer knows this package exists, and `tests/boundary.test.ts` fails if that ever
changes. No database, no service: a run is a directory, and history is one
append-only `index.jsonl`.

## Quick start

```bash
pnpm build                       # the harness runs the built runner (packages/runner/dist)
export ANTHROPIC_API_KEY=sk-ant-...      # or CLAUDE_CODE_OAUTH_TOKEN, see "Credentials"

pnpm eval tasks validate         # check every task is sound (no model calls)
pnpm eval run --dry-run          # what would run, and whether prerequisites are met
pnpm eval run --tasks 'small/*' --repeat 1   # a cheap first run
pnpm eval run                    # baseline scenario, every task, 3 attempts each
pnpm eval report                 # the latest run
pnpm eval compare <runA> <runB>  # paired comparison, B minus A
pnpm eval history                # solve rate over time (or --task <id> --metric cost)
pnpm eval dashboard              # browse runs and individual test results at localhost:4310
```

`pnpm eval` runs inside `packages/eval`, so a relative path given to a flag
(`--results-dir`, `--tasks-dir`, `--set coroPath=...`) resolves against that
directory. `pnpm --filter @coro-ai/eval test` and `... typecheck` run the harness's
own tests (about 300, none of which call a model).

Requirements on `PATH`: `node`, `git`, and, for the starter tasks, `npm` and `go`.
`run --dry-run` reports whichever is missing.

## What a run does

For every `task x attempt`:

1. **Sandbox.** The task's `repo/` is committed into a fresh git repository
   (branch `main`) in a scratch directory under the OS temp dir. It is *not*
   under this repo: Claude Code walks up from its working directory looking for
   `CLAUDE.md` files, and this repo's would leak into the agent's context.
2. **Isolated runner.** A runner process starts from the scenario's `coroPath`
   with its own `HOME`, its own config (built-in `local` SCM plugin, the
   scenario's lane/models/overlay), and its own free port. **Your real `~/.coro`
   is never read or written.** Environment variables that would steer the runner
   or Claude Code (`CORO_*`, `CLAUDE_*` model overrides, `npm_*`, `PNPM_*`, ...)
   are scrubbed, as are the ones that make a shell read *your* startup files
   (`ZDOTDIR`, `USER_ZDOTDIR`, `BASH_ENV`, `ENV`). An integrated terminal such as
   Cursor's exports `ZDOTDIR`, and without the scrub every Bash call the agent
   made failed on `~/.zshenv` lines that expect your real `$HOME`.
3. **Dispatch.** `POST /jobs` with the task description, lane workflow and the
   sandbox as the target repo. The description is the only thing Coro is told.
4. **Watch.** The harness polls `GET /jobs/:id` and tails the SSE log, keeping a
   timeline of status and phase changes, until the job reaches an outcome or the
   task's `timeoutMinutes` runs out.
5. **Reviewer.** When the job parks on a pull request (`awaiting-pr-merge`) the
   simulated reviewer approves it, and when the job marks the PR merged the
   reviewer merges its branch into the sandbox's `main`.
6. **Collect and grade.** Delivered code is checked out, the hidden tests are
   copied in, and the grader runs the task's commands. Optionally the LLM judge
   reads the diff.
7. **Store.** The attempt directory is written, one line is appended to
   `results/index.jsonl`, and the runner and scratch directory are removed.

Attempts run `parallel` at a time, each with its own runner process.

### Dashboard

`pnpm eval dashboard` starts a read-only local web view over the same plain
result files used by the report commands:

- Search runs by label, ID, lane or scenario hash. Refresh manually or enable
  15-second auto-refresh while viewing an ongoing run.
- See graded/planned progress, solve rate, pass@k, pass^k, cost per solved
  attempt and advisory judge scores. Rates describe **graded attempts only**;
  reliability and comparisons are provisional while a run is unfinished.
  Unfinished can also mean interrupted, not necessarily still running.
- Expand scenario/reproducibility details for models, overlays, overrides,
  concurrency and both checkout revisions (including dirty markers).
- Choose a baseline (A) to compare the current run (B) using the CLI's paired,
  noise-aware calculation. Deltas are B minus A; unmatched tasks and different
  scenarios are called out. The URL preserves the selected comparison.
- Filter attempts by task, solved result or outcome; sort by cost, time or
  rework. Click a task to narrow its attempts, or open an attempt directly.
- Inspect hidden/existing tests and checks, delivery branches, scope/reference
  size, judge issues, timeline, phase costs/models, tokens, tool failures and
  rate-limit retries. Older results without detailed metrics remain readable.
- Preview and download recorded logs, raw JSON and the delivered diff.
  Previews show at most the last 64 KiB; downloads include the entire file.

Use `--port`, `--host` or `--results-dir` to override the defaults. The
unauthenticated server accepts loopback hosts only and never starts, cancels
or changes evaluation runs.

### Outcomes

| Outcome | Meaning |
| --- | --- |
| `complete` / `failed` / `escalated` / `cancelled` | the job's own terminal status |
| `needs-human` | the job parked waiting for a developer (not a PR approval) for longer than the grace period |
| `timeout` | no result within the task's `timeoutMinutes`; the job is cancelled |
| `runner-crashed` | the runner process exited before the job finished |
| `dispatch-error` | the job could not be created |

### What "solved" means

For a task that expects a **PR**, an attempt is *solved* when something was
delivered **and** the hidden tests pass **and** the task's existing tests still
pass. Lint/typecheck `checks`, scope creep and the judge are recorded but do not
decide it. For a task that expects the job to **escalate**, `escalated` or
`needs-human` is the success condition.

"Delivered" is derived from git, not from the job's say-so: if `main` moved it is
`main`; otherwise it is the base plus every branch the job pushed that the
reviewer merged (`via: 'branches'`).

## Tasks

A task is a directory under `tasks/`:

```
tasks/<id>/
  task.yaml          # id (= directory name), size, language, description, expect, grade
  repo/              # the fixture, committed as the sandbox base
  hidden-tests/      # copied in only after the job ends; Coro never sees them
  reference.patch    # a human solution; used by `tasks validate` and shown to the judge
```

```yaml
id: ts-slugify
size: small                 # small | medium | large
language: typescript
expect: pr                  # pr (default) | escalate
timeoutMinutes: 30          # default 60
description: |              # the only thing Coro is told
  ...
grade:
  setup: npm ci --no-audit --no-fund   # run once in the graded checkout
  hiddenTests: npx vitest run hidden/  # required when expect: pr
  hiddenDir: hidden                    # where hidden-tests/ is copied (default: hidden)
  existingTests: npx vitest run tests/
  checks:                              # recorded, not part of "solved"
    - npx tsc --noEmit
  scope: ["src/**", "tests/**"]        # globs a change may touch; the rest is scope creep
```

Starter set:

| Task | Size | Language | Expects |
| --- | --- | --- | --- |
| `ts-slugify` | small | TypeScript | PR |
| `ts-fix-pagination` | small | TypeScript | PR |
| `ts-rate-limit` | medium | TypeScript | PR |
| `go-lru-ttl` | medium | Go | PR |
| `ts-inventory` | large | TypeScript | PR |
| `ts-ambiguous-export` | medium | TypeScript | escalate |

`pnpm eval tasks validate [selectors]` proves each task is well-formed: the hidden
tests must **fail** on the untouched fixture and **pass** with `reference.patch`
applied, and the existing tests must pass both ways. Run it after editing or
adding a task. Select tasks with comma-separated globs against `id`, `size/id`
or `language/id` (`ts-*`, `small/*`, `go/*`); `--tasks-dir` points at another set.

Keep fixtures free of anything Coro could use to find the hidden tests, and keep
descriptions specific enough that a hidden test is a fair reading of them. A
hidden test that checks something the description never said measures the task,
not Coro.

## Scenarios

A scenario is *how Coro is run*, as opposed to *what it is asked to do*. They are
files in `scenarios/`, and every key can be overridden when you run:

```bash
pnpm eval run --scenario baseline --set lane=deep --set models.coding=claude-sonnet-5-5
pnpm eval run --set coroPath=/path/to/other/worktree --label candidate
pnpm eval run --set tenantOverlayDir=/path/to/overlay --label with-new-skills
pnpm eval run --set codeReviewLenses=false --set judge.samples=3
```

| Key | Default | Meaning |
| --- | --- | --- |
| `coroPath` | `../..` | Coro checkout to run. Must be built (`pnpm build`). Point it at a git worktree of another branch to compare two versions. |
| `lane` | `standard` | `standard` / `fast` / `deep` (`.claude/commands/coro/job.md`, `job-fast.md`, `job-deep.md`). |
| `models` | `{}` | Model per tier (`planning`, `coding`, ...), written to `llm.aliases`. Empty keeps the runner's defaults. |
| `tenantOverlayDir` | `null` | A `localDir` tenant overlay, to A/B a change to agents/skills/memory markdown. |
| `codeReviewLenses` | `true` | The pre-PR review lenses inside the coding phase. |
| `repeat` / `parallel` | `3` / `2` | Attempts per task / attempts in flight. |
| `judge.enabled/model/samples` | `true` / `claude-opus-5-5` / `1` | The LLM judge. |
| `reviewer.approveAfterSeconds` | `0` | Delay before the simulated reviewer approves a PR. |
| `pollIntervalSeconds`, `startupTimeoutSeconds` | `5`, `90` | Harness timing. |

Unknown keys are an error, so `--set lanee=fast` fails instead of quietly running
the baseline. Values parse as JSON when they can (`5`, `true`, `null`, `["a"]`)
and as strings otherwise. Each run records a **scenario hash** over everything
that changes what Coro does (it leaves out `repeat`, `parallel`, `reviewer` and
the timing keys), so `history` and `compare` can tell runs of the same scenario
apart from runs that only share a label.

## Results

```
results/                                  # gitignored
  index.jsonl                             # one line per graded attempt, append-only
  <YYYY-MM-DDTHH-MM-SS>_<label>/          # run id, local time
    run.json                              # scenario + hash, overrides, tasks, Coro and harness commit (+dirty)
    summary.json                          # the aggregated report
    attempts/<task>-<n>/
      attempt.json  grade.json  metrics.json  timeline.json
      job.json                            # Coro's full job record
      diff.patch                          # what was delivered
      job.log  runner.log  grade.log
```

Everything is JSON or text, so `jq`, a spreadsheet, or `git diff` all work on it.
`index.jsonl` holds the numbers `history` reads (everything else is in the run
directories). `--results-dir` points at a different store.

### Metrics

Per attempt: outcome, solved, cost (USD), input/output tokens, wall time, **agent
time** (wall time minus waiting on the reviewer), **review wait**, phase runs and
rework runs (`phaseUsage` attributed as work-item, checkpoint-resume or rework;
treat `reworkRuns` as a floor), hidden/existing test counts, check results,
files outside the scope, and the judge's scores and issues.

Per run: solve rate, **pass@k** (a task solved at least once in its attempts),
**pass^k** (solved every time), and **cost per solved attempt** (all spend,
failed attempts included, divided by solved attempts).

### Comparing runs

`compare <a> <b>` reports **B minus A** overall and per task. Runs are matched on
task id, and each delta gets a verdict: `noise` when it is inside the spread
between attempts of the same task, `better` / `worse` when it is outside it,
`unknown` when either side has fewer than two attempts to measure a spread from,
and `n/a` when a metric is missing on one side. With `repeat: 3` on six tasks the
spread is wide, so treat a single comparison as a lead and repeat the run before
believing a small delta. `a`, `b` and `report`'s argument take a full run id,
`latest`, or any fragment (a label, a date) that matches exactly one run.

## The LLM judge

The judge reads the diff, the task description and the reference patch and
returns 1-5 scores (correctness, scope discipline, readability, test quality,
risk) plus a list of issues with severities. It is the least trustworthy signal
here and the harness treats it that way:

- It **never decides "solved"**; the hidden tests do.
- Use a judge model different from the model doing the coding (`--set judge.model=...`).
- With `judge.samples > 1`, scores are medians and an issue counts only when a
  majority of passes report it.
- It **uses the same credential as the runner**, so there is nothing extra to set
  up. With `ANTHROPIC_API_KEY` it calls the Messages API. With
  `CLAUDE_CODE_OAUTH_TOKEN` (the Messages API does not accept that token) it runs
  the `claude` CLI headless, which must be on `PATH`: no tools, no settings, no
  saved session, an empty working directory and a throwaway `HOME`, so it sees
  nothing of yours. Judge calls therefore count against your plan, or your API
  credits, exactly like the jobs do. `run` and `run --dry-run` print which route
  the judge will take.
- It is **skipped, not failed,** when the CLI route needs `claude` and it is not on
  `PATH`, when nothing was delivered, or with `--no-judge`. A judge call that
  errors is recorded in `grade.json` as `judge failed: ...` and does not fail the
  attempt. The reason is always in `grade.json`.
- Before relying on judge scores for decisions, have a person rate a sample of
  the same diffs and check how often they agree.

## Credentials and isolation

- **The runner under test does not use your installed Coro's login.** Each attempt
  gets a fresh config, and your installed Coro's default (`claudeLogin`, the
  Claude Code session in your keychain) cannot carry over: on macOS the keychain
  is found through `HOME`, which each attempt overrides. Instead the harness reads
  a credential from **its own environment**:
  - `ANTHROPIC_API_KEY`: an API key, **billed to that API account's credits**
    (a "Credit balance is too low" failure means that account is empty). It wins
    when both are set, so a key exported for some other tool is picked up silently.
  - `CLAUDE_CODE_OAUTH_TOKEN`: a Claude subscription token from `claude setup-token`;
    use it, with `ANTHROPIC_API_KEY` unset, to run on your plan instead. The judge
    follows suit through the `claude` CLI (see below), so it runs on your plan too.

  `run` prints which one it will use (the variable name, never the value), as does
  `run --dry-run`. The value goes into the attempt's `config.json` (mode 0600),
  is redacted in place after the run, and is never copied into `results/`.
- Every attempt has its own `HOME` (with its own `.gitconfig`) so the runner's
  state, local SCM records and git identity are separate from yours.
- npm and Go module caches are shared across attempts under `packages/eval/.cache`
  (gitignored) so repeated `npm ci` does not hit the network every time.
- Interrupting a run (Ctrl-C) stops the runners and shells it started.

## Things to know when reading the numbers

- **Review wait is not Coro's time.** In local mode the runner notices a PR
  approval by polling every 60 seconds, so each PR can add up to a minute of
  waiting that the harness cannot shorten. It is reported separately, and `wall`
  minus `review wait` is `agent`. Compare `agent`, not `wall`, across runs.
- **The reviewer is simple on purpose.** It approves everything and merges what
  the job marks merged. It does not leave comments, so rework caused by review
  feedback is not measured. This is the one place the harness reads a file Coro
  owns (the `local` SCM plugin's JSON record); `src/reviewer.ts` is the only file
  to update if that format changes.
- **`needs-human`** (a job waiting on a developer for longer than the grace
  period) ends the attempt. It counts as success only for `expect: escalate` tasks.
- **Concurrency costs money and can add noise.** `parallel` attempts run
  simultaneously against the same API quota; raise it for speed, lower it if you
  see rate-limit failures.
- **Comparing two versions of Coro** means two builds: create a `git worktree`
  of the other revision, run `pnpm build` there, and pass its path as `coroPath`.
  The run records each side's commit, marked `+dirty` if it had uncommitted changes.
- **It has not been run against a live model.** The unit and end-to-end tests
  drive a fake Coro (`tests/fixtures/fake-coro`) over the same HTTP routes, with
  real processes, git and grading, and the starter tasks are verified by
  `tasks validate`. The real runner was started and dispatched to with a dummy
  credential, which got as far as the model call (HTTP 401) with the isolated
  `HOME`, config, job record and results all as expected. Everything after that
  point (a real job opening a PR in the sandbox, the reviewer's approval and
  merge against the real `local` SCM plugin, real costs and timeouts) is
  unverified. Make the first real run a single small task
  (`pnpm eval run --tasks ts-slugify --repeat 1`) and read its `timeline.json`,
  `job.log` and `runner.log` before scaling up.

## Layout

```
bin/coro-eval.js        entry; runs src/cli.ts through tsx (no build step)
src/cli.ts              commands: run, report, compare, history, tasks, scenarios
src/run.ts              the run loop, preflight, attempt scheduling
src/attempt.ts          one attempt: sandbox -> runner -> dispatch -> watch -> collect -> grade
src/sandbox.ts          isolated HOME/config and the sandbox repository
src/runner-process.ts   spawn / health / teardown of `coro start`
src/coro-client.ts      the HTTP client (POST /jobs, GET /jobs/:id, SSE, cancel)
src/watch.ts            the status timeline and outcome decision
src/reviewer.ts         the simulated reviewer
src/collect.ts          delivered branch, diff.patch, job.json
src/metrics.ts          cost, tokens, durations, rework
src/grade/              tests, scope, judge
src/store.ts            run directories and index.jsonl
src/report.ts           aggregation, pass@k / pass^k, paired comparison, tables
tasks/  scenarios/  tests/
```

YAML is parsed with `js-yaml` (already used elsewhere in the monorepo).
