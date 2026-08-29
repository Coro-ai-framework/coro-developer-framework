# Coro — AI Agent Workspace

> **Agent runtime instructions** are in `packages/intelligence-base/layer/.claude/CLAUDE.md`. **This** file is for developers working on this repository.

This repository contains:

- The **Coro runner** (`packages/runner/`) — TypeScript/Node.js process that
  executes agent workflows.
- The **Coro dashboard** (`packages/dashboard/`) — React + Vite web UI.
- The **base intelligence layer** (`packages/intelligence-base/`) — the
  generic, company-agnostic agents, workflows, skills, and memory templates
  that ship with every Coro install. The runner reads its base intelligence
  from this package via `getBaseLayerRoot()`; nothing in the repo root
  shadows it anymore.

### Layered intelligence

Coro composes intelligence from three layers using a **hybrid model**:
the resolver owns Coro-specific content (`agents/`, `workflows/`,
`memory/`, `.claude/skills/`, `.claude/CLAUDE.md`); the target repo's
own `.claude/` is left for Claude Code's native loader to discover at
the SDK's `cwd`.

```
┌─────────────────────────────────────────────────────────────┐
│ Repo overlay        <repoCheckout>/.coro/                   │
├─────────────────────────────────────────────────────────────┤
│ Tenant overlay      localDir | gitRemote | cloudBlob        │
├─────────────────────────────────────────────────────────────┤
│ Base intelligence   @coro-ai/intelligence-base/layer/  ← here  │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
   <workingDir>/<jobId>/_intelligence/    ← materialised overlay
```

- **Base** is everything in `packages/intelligence-base/layer/`. It is
  intentionally company-agnostic: no BitBucket workspace names, no service
  accounts, no migration stories. It is the contract every tenant extends.
- **Tenant overlay** supplies company-specific facts (service-account
  identities, observability endpoints, deployment substrate, etc.).
  Declared via `tenant.overlay` in `~/.coro/config.json` (solo) or by
  the cloud control plane (hybrid, Phase 5). Three source kinds:
  `localDir` (filesystem), `gitRemote` (cached clone under
  `~/.coro/cache/tenant-overlays/<tenantId>/`), and `cloudBlob`
  (Phase 5 stub today — warns and skips).
- **Repo overlay** is per-target-repo customisation that lives in a
  `.coro/` folder inside the repo being worked on. The resolver
  intentionally does NOT touch the repo's `.claude/` — that contract
  belongs to Claude Code's native walk-up via
  `settingSources: ['project']`.

#### Merge semantics

Two deterministic rules, applied per-file as the resolver stacks
layers:

| Path | Mode | Rationale |
|---|---|---|
| `.claude/CLAUDE.md` | **append** with banners | Mirrors Claude Code's native CLAUDE.md walk-up; tenants extend, never overwrite, base guidance. |
| `memory/**/*.md` | **append** with banners | Memory is cumulative knowledge — additions never erase prior entries. |
| Everything else (`agents/`, `workflows/`, `.claude/skills/`, `.claude/settings.json`, …) | **last-wins** (file replace) | Predictable per-path override; tenants and repos can fully redefine an agent or workflow. |

Append banners look like `<!-- ─── coro layer: tenant:team-abc ─── -->`
so the model can see provenance when reading the merged file.

Important: these merge rules apply only to the resolver's read-time
materialisation into `<workingDir>/<jobId>/_intelligence/`. Proposal
shipping is a separate write path. `propose_change` must materialise
diffs against the writable tenant/repo source clone, never against the
constructed `_intelligence` tree. In particular, memory-update
proposals append against the current source file in the writer clone;
`memory/MEMORY.md` remains an authored index update rather than an
append-only stream.

#### Resolver lifecycle

The **intelligence resolver**
(`packages/runner/src/intelligence/resolver.ts`) runs:

1. **At job start** — materialises base + tenant + (opportunistic) repo
   overlay into `<workingDir>/<jobId>/_intelligence/`.
2. **At every phase boundary** — re-resolves idempotently. This is how
   the repo overlay (`<workingDir>/<repoSlug>/.coro/`) gets picked up:
   the agent typically clones the target repo during phase 1, so phase
   2 onward sees the now-present repo `.coro/`.

The runner points all per-job markdown reads (workflow loader, prompt
builder, subagent loader, filesystem hooks) at the resolved path. The
HTTP server still reads `settings.paths.coroIntelligenceDir` for the
read-only mirror it serves — it is tenant-agnostic by design.

#### Tenant context

Every runner instance carries a `TenantContext`
(`packages/runner/src/intelligence/tenant-context.ts`) that identifies
which tenant a job belongs to:

- **Local mode** (single-host SQLite + polling) synthesises `solo-<host>`
  from the OS hostname. The local config can attach a `tenant.overlay`
  source so a single-host solo deployment still benefits from a tenant
  overlay.
- **Hybrid mode** derives `team-<teamId>` from the JWT used to
  authenticate to the cloud control plane. Phase 4 leaves the
  cloud-supplied overlay descriptor `undefined`; Phase 5 wires it in
  via the WebSocket handshake.

The `TenantContext` is attached to the `RunnerContext` at bootstrap and
to the `ToolContext` per job. The intelligence resolver reads it to
decide which tenant overlay to apply; MCP tools that write back to
memory or proposals will use it to route writes to the right layer in
later phases.

## How this system works

Agents in this repository do not run directly inside Claude Code sessions. They are driven by the **Coro Runner** — an always-running TypeScript/Node.js service (`packages/runner/`) that:

1. Receives job requests from the `coro` CLI or external event sources (BitBucket webhooks, Jira webhooks)
2. Creates a typed `Job` object with a `workflowPath` pointing to the correct workflow MD file
3. Assembles a system prompt from the workflow file, agent instructions, and memory — static content (behavior rules, tenant context, git conventions) is loaded natively by the SDK from `.claude/CLAUDE.md`
4. Resolves a `PhaseExecutor` plugin (default: `@coro-ai/llm-anthropic`) and calls `executor.executePhase()` for each workflow phase. The executor encapsulates the LLM SDK call, manages the tool-use loop, subagent spawning, and conversation history. Per-phase provider/model is resolved by the runner via `settings.llm.aliases` and optional `provider:` overrides in the workflow YAML. The runner core has zero direct Anthropic-SDK imports.
5. Parks the job in Redis when waiting for an external event (PR merge, review comment, human approval)
6. Resumes the job when the expected event webhook arrives

**The MD files in this repo are the intelligence. The Coro Runner is the infrastructure that runs them.**

### Design philosophy

**TypeScript = dumb tool shell.** It runs phases linearly, provides MCP tools, persists state (Redis / SQLite / cloud), and parks/resumes on webhooks. It has zero orchestration intelligence.

**Intelligence = MD files + LLM judgment.** Workflow markdown defines phases and metadata. Agent markdown defines procedures. The LLM reads artifacts, calls tools to update state, and uses `goto_phase` to control flow. The evaluator decides when to loop. The planner decides how many features. The coder decides when it needs a fresh session.

Full architecture: [docs/architecture.md](docs/architecture.md)
Local setup guide: [docs/local-setup.md](docs/local-setup.md)
Coro Runner technical spec: [docs/agent-host-spec.md](docs/agent-host-spec.md)

---

## Job types and workflow routing

Every job carries a `type` and a `workflowPath`. The runner uses these — not hardcoded logic — to decide which workflow and which agents to run. This is how new workflows drop in without changing the infrastructure.

| Trigger | JobType | workflowPath |
|---------|---------|-------------|
| `coro job ...` (CLI) | `job` | `workflows/job/workflow.md` |
| Jira ticket assigned to agent | `job` | `workflows/job/workflow.md` |
| Agent writes to `memory/`, `agents/`, or `.claude/` | `self-update` | *(inline, no workflow file)* |
| **Run Retrospective** (dashboard / `coro retrospective run`) | `retrospective` | `workflows/retrospective/workflow.md` |
| `dispatch_improvement_job` (from a retrospective) | `job` | `workflows/oss-contribution/workflow.md` |

---

## What lives here

- **agents/** — One MD file per agent. Each defines role, inputs, outputs, and step-by-step procedure. Agents are language-agnostic generic process definitions.
- **workflows/** — Lifecycle definitions, one subdirectory per workflow type. Each `workflow.md` has YAML front matter defining phases, agent assignments, model selection, and subagent definitions.
- **.claude/** — Intelligence loaded by the Agent SDK natively:
  - `.claude/CLAUDE.md` — Always-loaded runtime instructions: behavior rules, tenant context, git conventions, infrastructure context.
  - `.claude/skills/` — On-demand domain knowledge and language conventions. Agents invoke skills when they need specialized guidance (e.g., `feature-planning`, `golang-conventions`).
- **config/** — `credentials.md` (gitignored, read by the runner at startup) and `repos.md` (service registry).
- **memory/** — Accumulated knowledge from past jobs. Read at the start of every phase. Never modified directly — updates go through a self-improvement PR.
- **docs/** — Architecture documentation for engineers and stakeholders.
- **packages/runner/** — The Coro Runner (TypeScript/Node.js). Local agent runtime, cloud control plane, and the `coro` CLI.
- **packages/dashboard/** — The Coro Dashboard (React + Vite). Web UI for jobs, intelligence editing, and tenant administration.

---

## Language-agnostic architecture

The system is fully language-agnostic. No language-specific defaults are hardcoded in the infrastructure. Language support works through two layers:

1. **Convention skills** (`.claude/skills/{language}-conventions/SKILL.md`) — coding standards per language. Adding a new language means writing one skill file.
2. **Planner agent** — detects the target language from the repository (e.g., `go.mod` → `golang`, `*.csproj` → `dotnet`) and calls `set_job_params({ language: "..." })` so downstream agents know which conventions skill to invoke.

---

## Agents

| Agent file | Phase(s) / role | Used by workflows |
|-----------|----------------|------------------|
| `agents/planner.md` | planning | job |
| `agents/coder.md` | coding | job |
| `agents/code-reviewer.md` | `code-reviewer` subagent invoked by the coder pre-PR-open | job |
| `agents/pr-reviewer.md` | review (merge gatekeeper) | job |
| `agents/evaluator.md` | evaluation (verify build/tests/acceptance criteria + loop control) | job |
| `agents/spec-writer.md` | spec-writing | job (Jira-triggered) |
| `agents/campaign-planner.md` | campaign-planning | campaign |
| `agents/campaign-evaluator.md` | aggregation | campaign |
| `agents/retrospective-analyst.md` | analysis + shipping (cross-job self-analysis) | retrospective |
| `agents/oss-planner.md` | planning (contribution only — no campaign/lanes) | oss-contribution |
| `agents/oss-coder.md` | coding on the fork | oss-contribution |
| `agents/oss-verifier.md` | pre-PR test/wording gate | oss-contribution |
| `agents/oss-contributor.md` | contribution (opens the fork → upstream PR) | oss-contribution |

Generic job agents are workflow-agnostic and language-agnostic. They receive
domain-specific expertise by invoking skills on-demand. The same coder agent
works for Go, .NET, and TypeScript projects — the invoked skills change, not
the agent. The oss-contribution workflow is the exception: it uses dedicated
agents so a contribution job cannot run campaign promotion, lane switching,
or a merge-gatekeeper review.

The implementation-job pipeline is intentionally tight: the convention/plan/test-coverage **review** happens once, inside the coding phase, via the `code-reviewer` subagent. The standalone `review` phase is a thin merge gatekeeper that handles human coordination + merge. **Build/test verification and acceptance-criteria checks** are owned by the evaluator (which runs them on the merged commit). Earlier versions had separate `review` and `testing` phases that re-did the same work — that has been consolidated to keep token cost and wall-clock time down without losing any robustness.

---

## Skills

On-demand domain knowledge and language conventions that agents invoke via the `Skill` tool:

```
packages/intelligence-base/layer/.claude/skills/
  feature-planning/SKILL.md         — Generic implementation planning guidance
  feature-testing/SKILL.md          — Generic implementation testing guidance
  golang-conventions/SKILL.md       — Go coding standards
  dotnet-conventions/SKILL.md       — .NET/C# coding standards
  sandbox-recovery/SKILL.md         — Recovery playbook for host-sandbox denials
  self-improvement-guide/SKILL.md   — Proposal types and file structure guide
  retrospective-analysis/SKILL.md   — Thresholds + categorisation for cross-job self-analysis
```

(Abridged — the directory holds the full set; the entries above are the ones
referenced most often in this document.)

Skills are invoked on-demand by agents, reducing per-phase token costs compared to always-injected knowledge modules.

---

## How to start a workflow

```bash
coro job \
  --repo my-service-go \
  --description "Add rate limiting to /api/users" \
  --reviewers alice,bob

# Check job status
coro status --job my-service-job-1712123456789

# Stream live logs for a running job
coro logs --job my-service-job-1712123456789

# List all jobs
coro jobs
```

---

## Self-improvement rule

When any agent calls `propose_change`, the runner synchronously:

1. Validates the proposal (path allowlist per layer, frontmatter / heading checks per type)
2. Routes the change to the right writable layer — **tenant** (the configured intelligence repo, identical for solo and team) or **repo** (the project's `.coro/` overlay). The base layer that ships with the runner is never written.
3. Cuts a branch `coro/proposal/<jobId>-<layer>-<slug>` from that layer's default branch
4. Materialises the proposed file contents against that writable source clone. For `memory-update`, append-only memory files merge into the current file in the writer clone; they are not regenerated from `_intelligence`.
5. Commits every file in the multi-file payload as one atomic commit
6. Pushes and opens a PR via the configured git provider (GitHub or Bitbucket)
7. Records the proposal in the state backend so `list_proposals` and the dashboard can surface it

**Agent knowledge improvements are always reviewed by humans before becoming canonical.** No agent can silently modify how other agents behave. Once the PR merges, the next job's intelligence resolver pulls the merged change automatically.

Each call produces exactly one PR. Bundle every file change for a layer into one `propose_change` call — splitting creates duplicate PRs. The Evaluator (and PR Reviewer for cross-PR systemic patterns) is responsible for grooming insights into a single multi-file proposal per layer per job.

The self-improvement pipeline covers three writable surfaces (across the tenant and repo layers):
- **Memory** (`memory/*.md` tenant, `.coro/memory/*.md` repo) — high volatility, grows with every job
- **Skills** (`.claude/skills/*/SKILL.md`) — medium volatility, updated when agents discover systemic gaps
- **Agent instructions** (`agents/*.md`) — lower volatility, updated when procedures need fixing

### Cross-job self-improvement: the retrospective

`propose_change` is a *per-job* loop — the evaluator sees only the job it
ran in. That is enough to capture "this build needs CGO_ENABLED=0"; it can
never notice "the coding phase loops on every Go job", because no agent
has ever seen two jobs at once.

The **retrospective** (`workflows/retrospective/workflow.md`, job type
`retrospective`) is that missing view. It is dispatched on demand, reads
the install's own job records through three read-only MCP tools —
`list_jobs`, `get_job_report`, `get_job_log_excerpts`, implemented in
`packages/runner/src/tools/job-history.ts` — and produces findings that
cite at least two jobs each with concrete metrics.

Those metrics have to be interpreted before they mean anything, and that
is `attributePhaseRuns`' job. A repeated phase is usually not a loop:
`coding → review → coding` is the required path for every work item, and
approving a checkpoint re-enters the departing phase so the agent can
finish its turn. Attributing each `phaseUsage` snapshot as `work-item`,
`checkpoint-resume`, or `rework` is what stops the analyst reading a
six-run coding phase on a three-work-item job as pathological — it filed
exactly that false finding when the report exposed only raw run counts.
The attribution is derived (work-item stamps plus the workflow's declared
checkpoints), never recorded, so it is deliberately tuned to undercount:
`reworkRuns` is a floor, and a finding built on it is a candidate rather
than a proof.

**A finding's evidence and its remedy come from different places**, and
only the first one is metrics. "The coder loops on Go test scaffolding" is
supported by job reports; "…because `job-history.ts` does not persist
per-run cost" is a claim about a codebase the analyst has never read, and
it was wrong the first time it was made — the field was already there.
`upstream_checkout` (`tools/upstream-source.ts`) closes that gap by
putting a read-only snapshot of the upstream default branch in the job's
own working directory, so the claim can be checked before it reaches a
public issue. Three details carry weight:

- **Upstream's `main`, not the installed version.** The finding is going
  upstream, so what matters is whether the defect is still there — this is
  the only way the analyst notices something maintainers already fixed.
- **A snapshot, not a checkout.** `.git` is removed once the revision is
  recorded, so nothing can be branched or pushed from it and the
  workspace/diff machinery cannot mistake it for the job's target repo.
  Fixes still go out through `dispatch_improvement_job`; a finding
  still needs its two citing jobs, because a problem noticed by reading
  code with no run behind it is a code review, not a retrospective finding.

Three properties make this safe to ship:

1. **Type-gated tools.** The history tools reject any job whose type is
   not `retrospective` (`tools/retrospective.ts`). An implementation job
   cannot trawl the install's history.
2. **Sanitised by default.** `tools/sanitize.ts` maps every known tenant
   identifier (repo slugs, SCM org names, tracker keys, e-mails, tenant
   id) to a stable alias, and the same object validates text in the other
   direction so anything bound for a public repository fails closed.
3. **A human checkpoint between finding and shipping.** The `analysis`
   phase carries `interactive_checkpoint: true`, so the runner parks the
   job in `awaiting-developer-input` before `shipping` runs. Note the
   checkpoint sits on the phase being *left*, not the phase being
   entered — and the park only happens when `job.interactive` is true,
   which is why the dashboard always dispatches retrospectives with
   `params.interactive = true`.

The approval has to *arrive* somewhere, and that is not automatic. A
boundary approval is framed into `pendingPrompt`, which the departing
phase consumes on its last turn — so `shipping` would otherwise start
with a plain kickoff and no idea what was approved. `Job.checkpointApproval`
is what closes that gap: `Dispatcher.sendMessage` records the reply against
the phase it releases (`forPhase`), `buildCheckpointApprovalBlock` leads
that phase's kickoff with it, and the runner clears it on consumption.
Every workflow with a checkpoint gets this; the retrospective is only the
first that cannot work without it.

Because `shipping` acts per finding, an unqualified "approved" is not
enough input. The dashboard therefore renders the report's `findings[]` as
a per-finding ballot (`components/retrospective/findings-list.tsx`) and
`composeApprovalMessage` turns the toggles into the `Approved findings:` /
`Skipped findings:` lines the analyst parses. The ballot feeds the existing
approve button rather than adding a second one, so there is one approval
action on the page. A reply that names no ids still means "all of it" —
`agents/retrospective-analyst.md` reads it that way so a CLI `coro message`
approval works too.

Findings are categorised by which layer owns the fix:
`tenant-intelligence` ships via `propose_change`, while `base-intelligence`
and `runner-code` belong to the open-source repository.

**Upstream contribution** (`tools/upstream.ts`) is how the latter two
leave the machine: `upstream_checkout` (verify) → `upstream_search` →
`upstream_create_issue` or `upstream_comment_issue` →
`dispatch_improvement_job`. The retrospective does not write file
bodies. It is off unless the install sets `upstream.repoUrl` — via
**Settings → Coro contribution**, `~/.coro/config.json`, or
`CORO_UPSTREAM_REPO_URL` — and four constraints bound it:

- **Fingerprint dedup.** `fingerprintFinding()` hashes the finding's
  category, target paths, and normalised title, and the hash is embedded
  in the issue body as `<!-- coro-retro:<hash> -->`. The agent never
  supplies it, so two installs that independently hit the same defect
  converge on one issue instead of filing near-duplicates.
- **Tier gate.** The developer picks at launch how far findings may
  travel (`params.tiers`); the tools re-read that from the job, so an
  analyst cannot widen its own scope mid-run. `upstream_checkout` passes
  when *either* contribution tier is on — a run that cannot publish has
  nothing to verify for publication, and cloning for it is pure cost. The
  local destination is gated the same way (`assertTenantTierPermitted` in
  `tools/self-improvement.ts`), and only for retrospectives: ordinary jobs
  carry no tiers, so the evaluator's `propose_change` is untouched.
- **Fail-closed sanitisation.** Every title, body, and briefing is run
  through `Sanitizer.findLeaks()` before the request goes out. A leak
  cannot be un-published, so the check refuses rather than scrubs.
- **Per-run caps.** `upstream.maxIssuesPerRun` / `maxCodeJobsPerRun`,
  counted in `job.params` (not in memory) so a retried phase cannot
  reset its own budget. The charge lands before the API call.

PRs go out from a fork: `ensureFork` creates it if needed, `syncFork`
fast-forwards it to the upstream default branch, and
`dispatch_improvement_job` starts an implementation job on
`workflows/oss-contribution/workflow.md` (oss-planner → oss-coder →
verification → `agents/oss-contributor.md`). That job clones the **fork**
(`params.repo`), opens its PR against **upstream** (`params.upstreamRepo`
+ `params.prSourceOwner`), and ends there — nobody here can merge it.
Intelligence markdown and runner code live in the same repository, so
one call may carry several approved findings (`params.findings`); the
child planner keeps them in one PR when they are one reviewable story.
The shape lives in `jobs/oss-contribution.ts`; dispatch reaches the tool
through `ToolContext.dispatchJob`, a single-method capability the
`Dispatcher` passes into `runJob` rather than handing tools the dispatcher
itself. The child is capped by `upstream.maxCodeJobsPerRun`, cannot promote
itself into a campaign (`epicAllowed: false`), and is linked from the
finding's outcome as `childJobId`. The retrospective does not wait for it.

**One identity owns the fork and writes to it.** `upstream.token` used to
authenticate only the retrospective's own REST calls, so the child job pushed
and opened its PR as the SCM plugin instead — a different account whenever the
two are configured separately, which GitHub refused only after the work was
committed. `config/contribution-credential.ts` closes that by making the
contribution identity a property of *repositories* rather than of a job type:
it claims the fork and the upstream repo, and nothing else. That keying is
forced rather than chosen — the git credential helper runs as a separate
process (`coro git-credential`) that receives only protocol/host/path from
git, so a rule carried in `job.params` could never reach it, while one derived
from config reaches both the helper and the in-process plugin. Two consumers:
`fillGitCredential` (checked before plugin resolution, so it answers even when
no plugin claims the host) and the GitHub plugin's `clientFor` / `tokenFor`,
which route every `owner/repo`-addressed call. It is applied out-of-band via
`applyContributionCredential` rather than merged into the plugin's config slot,
since `GET /config` only knows to redact the token where it already lives.
With no `upstream.token` the resolver returns `undefined` and everything keeps
using the plugin identity — which is correct, because the fork was then
created with the plugin's own token.

Both halves must agree on *where the fork lives*, which is why
`forkOwner`'s fallback to the GitHub plugin's owner happens once, in
`resolveUpstreamConfig`, and nowhere else. While `upstream.ts` and the
credential resolver each applied their own, a config with `upstream.token`
set and `forkOwner` blank created the fork with the contribution token and
then pushed to it with the plugin's — the same 403, reachable through a
config shape the first fix did not cover. `mcpServer()` is the one surface
that cannot honour any of this: it is a single process holding a single
token chosen before any repository is named, so contribution jobs are told
(in the GitHub clone snippet and `agents/oss-contributor.md`) to use the
in-process `scm_*` tools rather than `mcp__github__*`.

**Surfaces.** Three runner endpoints back both triggers —
`POST /retrospectives` (dispatch; 409 while one is already running),
`GET /retrospectives` (history with findings parsed out of the artefacts),
and `GET /retrospectives/:jobId` (one run's findings). The dispatch shape
lives in `jobs/retrospective.ts` so the CLI (`coro retrospective
run|list`) and the dashboard's Retrospective page produce identical jobs.
`summarizeRetrospective` is the only reader of the report artefact
payload: the dashboard never parses it, which is why the findings panel on
job detail fetches `GET /retrospectives/:jobId` instead of reading
`job.artifacts`. Approval itself reuses the ordinary interactive
checkpoint UI (`ApprovalBox` → `POST /jobs/:id/message`) — the
retrospective adds a findings panel above it, not a second approval path.

The contribution destination is editable from the dashboard
(`Settings → Coro contribution`, `pages/Settings/sections/ContributionSection.tsx`).
`GET /config` redacts `upstream.token` and reports
`resolved.upstreamConfigured`, which is derived from
`resolveUpstreamConfig()` rather than from `config.upstream` so an
env-configured install reads as configured too. The launch form uses that
flag to disable the two contribution tiers, since
`assertRetrospectiveTiersAvailable` refuses a run it cannot honour instead
of quietly downgrading it.

---

## Repository structure

```
coro/                                    ← workspace root
├── CLAUDE.md                            ← You are here. Developer-facing guide.
├── package.json                         ← pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json                   ← Shared TS compiler options
├── README.md                            ← User-facing quick start + workflows
├── docs/                                ← Architecture documentation
│
└── packages/                            ← pnpm workspace packages
    ├── intelligence-base/               ← @coro-ai/intelligence-base — base intelligence layer
    │   ├── package.json
    │   ├── README.md
    │   ├── src/index.ts                 ← Manifest: getBaseLayerRoot(), pathInBaseLayer()
    │   ├── tests/manifest.test.ts
    │   └── layer/                       ← THE canonical generic intelligence
    │       ├── .claude/
    │       │   ├── CLAUDE.md            ← Generic Coro runtime instructions
    │       │   └── skills/
    │       │       ├── feature-planning/SKILL.md
    │       │       ├── feature-testing/SKILL.md
    │       │       ├── golang-conventions/SKILL.md
    │       │       ├── dotnet-conventions/SKILL.md
    │       │       └── self-improvement-guide/SKILL.md
    │       ├── agents/                  ← Generic agent role definitions
    │       ├── workflows/               ← Generic workflow phase definitions
    │       └── memory/                  ← Empty memory templates (tenants populate)
    ├── runner/                          ← Coro Runner (TypeScript/Node.js)
    │   ├── docker-compose.cloud.yml     ← Cloud control plane stack: postgres + redis
    │   ├── package.json                 ← @coro-ai/runner
    │   ├── tsconfig.json
    │   ├── cli/                         ← The `coro` CLI
    │   │   ├── index.ts                 ← Top-level program (`coro start`, …)
    │   │   ├── browser-open.ts          ← Auto-opens dashboard with headless detection
    │   │   └── commands/                ← start, job, login, init, runner, logs, status, …
    │   └── src/
    │       ├── dashboard-dist.ts        ← Resolves built dashboard assets (shared helper)
    │       ├── (llm-anthropic cli-path) ← Claude Agent SDK CLI resolved by @coro-ai/llm-anthropic
    │       ├── mcp-server.ts            ← In-process MCP server (Coro domain tools)
    │       ├── mcp-handlers.ts
    │       ├── workflow-parser.ts
    │       ├── config/                  ← settings.ts (types only), local-config.ts
    │       ├── jobs/                    ← runner.ts, dispatcher.ts, types.ts
    │       ├── clients/                 ← bitbucket, github, git, jira, loki, tempo
    │       ├── prompt/builder.ts
    │       ├── plugins/                 ← Plugin registry, loaders, builtin executor wiring
    │       │   ├── registry.ts          ← PluginRegistry: resolveScm/Tracker/Executor + resolvePhaseAssignment
    │       │   ├── loaders.ts           ← Disk + workspace plugin loading
    │       │   └── builtin/             ← buildBuiltinPluginRegistry (registers @coro-ai/llm-anthropic)
    │       ├── intelligence/            ← Layered intelligence
    │       │   ├── tenant-context.ts    ← TenantContext (solo / team)
    │       │   ├── resolver.ts          ← Per-job overlay materialisation
    │       │   ├── merge.ts             ← Layer merge primitives (replace + append)
    │       │   └── loaders/             ← localDir, gitRemote, cloudBlob, repo .coro/
    │       ├── runner/                  ← Local + hybrid bootstrap (`coro start`)
    │       │   ├── index.ts             ← startRunner(): mode dispatch + bootstrap
    │       │   ├── server.ts            ← Express server: /dashboard, /jobs, /config, …
    │       │   ├── claude-login.ts      ← Claude OAuth login flow used by dashboard
    │       │   └── hybrid-dispatcher.ts ← WebSocket-driven cloud job dispatch
    │       ├── cloud/                   ← Cloud control plane service
    │       ├── state/                   ← SQLite (local) and cloud-backed (hybrid) state backends
    │       └── tools/                   ← MCP tool implementations
    ├── dashboard/                       ← Coro Dashboard (React + Vite)
    │   ├── package.json                 ← @coro-ai/dashboard
    │   ├── vite.config.ts
    │   └── src/                         ← React UI (jobs, intelligence, settings)
    ├── plugin-sdk/                      ← @coro-ai/plugin-sdk — public SDK for plugin authors
    │   └── src/                         ← types.ts, base.ts, helpers.ts (ScmPluginBase, TrackerPluginBase, ExecutorPluginBase, PhaseExecutor)
    ├── llm-anthropic/                   ← @coro-ai/llm-anthropic — built-in Anthropic phase executor plugin
    │   └── src/                         ← executor.ts (wraps @anthropic-ai/claude-agent-sdk), auth.ts, index.ts
    ├── plugin-gitlab/                   ← @coro-ai/plugin-gitlab — example external SCM plugin
    └── desktop-electron/                ← @coro-ai/desktop-electron — Electron shell that bundles runner + dashboard
```
