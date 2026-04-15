# Plan: Multi-Tenant Agent Host

## TL;DR

Convert the single-tenant Agent Host into a multi-tenant system where each tenant has their own **intelligence folder** (agents, workflows, memory, skills, conventions), **credentials**, and **isolated working directories** — while sharing the Agent Host infrastructure (TypeScript runtime, Redis, HTTP server).

The design follows a "tenant config + path resolution" approach: a tenant registry in settings defines each tenant's intelligence directory and credentials, and every code path that currently reads from global `settings.paths.a5aiDir` instead resolves the tenant-specific path from `job.tenantId`.

---

## Architecture

```
/data/
├── tenants/                          ← Per-tenant intelligence (each is a git repo)
│   ├── a5labs/
│   │   ├── .claude/CLAUDE.md
│   │   ├── .claude/skills/
│   │   ├── agents/
│   │   ├── workflows/
│   │   ├── memory/
│   │   └── config/repos.md
│   └── acme-corp/
│       ├── .claude/CLAUDE.md         ← Different behavior rules
│       ├── agents/                   ← Different agent instructions
│       ├── workflows/                ← Different workflows
│       └── memory/                   ← Isolated knowledge base
├── working/                          ← Per-tenant, per-job sandboxes
│   ├── a5labs/
│   │   └── {job-id}/
│   └── acme-corp/
│       └── {job-id}/
└── tools/                            ← Shared Agent Host (unchanged binary)
```

### Key design decisions

- **Tenant = intelligence folder.** A tenant is defined by their own git repo containing the `a5-ai`-shaped intelligence structure. This makes onboarding a new tenant = cloning their intelligence repo + adding a config entry.
- **Default tenant for backward compat.** If no `tenantId` in request, assume `"default"` which maps to the current `a5aiDir`. Zero breaking changes on day 1.
- **Job IDs stay globally unique.** No tenant prefix in job IDs. The `tenantId` field on the Job object provides the association.
- **Redis key namespacing for listing/queries.** Per-job keys stay global (job IDs are unique). Listing/filtering keys get tenant prefix.
- **Per-tenant credentials.** Each tenant has their own BitBucket workspace, webhook secret, and optionally their own Anthropic API key, Loki, Tempo, Jira.

---

## Steps

### Phase 1: Data Model & Tenant Registry (foundation)

**1.1 Add `TenantConfig` and `tenantId` to core types**
- File: `tools/src/config/settings.ts`
  - Add `TenantConfig` interface with: `id`, `intelligenceDir`, `bitbucket` (workspace + accounts + webhookSecret), optional `claude`, `loki`, `tempo`, `jira` overrides
  - Add `tenants: TenantConfig[]` to `Settings`
  - Add `paths.tenantsDir` (base directory for tenant intelligence folders)
  - Add `resolveTenantConfig(settings, tenantId): TenantConfig` helper that looks up tenant by ID, falls back to default
  - Keep `paths.a5aiDir` as the default tenant's intelligence dir for backward compat
  - Add validation: each tenant must have an `id`, `intelligenceDir` that exists, and required BB credentials

- File: `tools/src/jobs/types.ts`
  - Add `tenantId: string` to `Job` interface
  - Add `tenantId: string` to `JobInput` interface
  - Default to `"default"` in `emptyJob()` / creation code paths

- File: `tools/config/settings.example.json`
  - Add `tenants` array example with one default tenant
  - Add `paths.tenantsDir` example

**1.2 Update JobRegistry for tenant-aware storage**
- File: `tools/src/jobs/registry.ts`
  - Add tenant-scoped key functions: `keyTenantJobs(tenantId)` → `t:{tenantId}:jobs`, `keyTenantPr(tenantId, prId)` → `t:{tenantId}:pr:{prId}:job`, `keyTenantRepo(tenantId, repoSlug)` → `t:{tenantId}:repo:{repoSlug}:jobs`
  - `persist()`: write to both global `jobs:all` AND `t:{tenantId}:jobs`
  - `listJobs(tenantId?)`: when tenantId provided, use `t:{tenantId}:jobs`; when omitted, use global `jobs:all` (admin view)
  - `listJobsByType(tenantId, type)`: scope by tenant
  - `getJobByPr()`: stays global (webhooks don't know the tenant upfront) — fetches job, then reads tenantId from it
  - `mapPrToJob()`: write global key (for webhook routing) + tenant-scoped key
  - `createJob(input)`: pass `tenantId` from `JobInput` into the `Job` object

*Depends on: nothing*

**Verification:**
- Unit tests: create two jobs with different tenantIds, verify `listJobs(tenantA)` returns only tenant A's jobs
- Unit test: `getJobByPr()` returns job with correct tenantId regardless of tenant
- Existing tests pass (default tenantId = "default")

---

### Phase 2: Tenant-Aware Runner & Prompt Builder (core execution)

**2.1 Runner resolves tenant context per-job**
- File: `tools/src/jobs/runner.ts`
  - At the top of the phase loop, call `resolveTenantConfig(settings, liveJob.tenantId)` to get the tenant config
  - Replace `settings.paths.a5aiDir` with `tenantConfig.intelligenceDir` for:
    - `loadWorkflowConfig(job.workflowPath, intelligenceDir, logger)` (line ~103)
    - `ensureClaudeConfigSymlink(workingDir, intelligenceDir, logger)` (line ~173)
    - `buildSubagentDefinitions(..., intelligenceDir)` — read `.claude/CLAUDE.md` and agent files from tenant dir
  - Replace `settings.paths.workingDir` with `path.join(settings.paths.workingDir, liveJob.tenantId, liveJob.id)` (line ~170)
  - Replace BB env vars with tenant-specific credentials:
    - `BB_WORKSPACE: tenantConfig.bitbucket.workspace`
    - `BB_CODER_APP_PASSWORD: tenantConfig.bitbucket.coderAccount.appPassword`
    - `BB_GIT_USERNAME: resolveGitUsername(tenantConfig.bitbucket.coderAccount)`
    - `ANTHROPIC_API_KEY: tenantConfig.claude?.apiKey ?? settings.claude.apiKey`
  - Replace model selection: use `tenantConfig.claude?.planningModel ?? settings.claude.planningModel` (and same for codingModel)

**2.2 Prompt builder accepts intelligence directory**
- File: `tools/src/prompt/builder.ts`
  - Change signature: `buildSystemPrompt(job, intelligenceDir, gitClient, logger)` — remove `settings` parameter, accept resolved `intelligenceDir` string
  - Replace all `settings.paths.a5aiDir` references with `intelligenceDir` (workflow loading, agent loading, memory loading, proposals loading)
  - `gitClient.pull(intelligenceDir)` — pulls the tenant's intelligence repo
  - Update call site in `runner.ts` to pass `tenantConfig.intelligenceDir`

**2.3 Per-tenant MCP tool clients**
- File: `tools/src/jobs/runner.ts`
  - Create BB clients per-job from tenant config: `createBitBucketClients(tenantBBConfig)` instead of using shared `ctx.bbCoder` / `ctx.bbReviewer`
  - Create Loki/Tempo/Jira clients from tenant config (fall back to global if tenant doesn't specify)
  - Pass tenant-specific clients into `ToolContext`
  - The `RunnerContext` keeps global clients as defaults; runner creates tenant-specific ones when the tenant config has overrides

*Depends on: Phase 1 (tenantId on Job, TenantConfig in settings)*

**Verification:**
- Integration test: run two jobs with different tenantIds, verify each loads agents/workflows/memory from the correct intelligence directory
- Verify working directories are `{workingDir}/{tenantId}/{jobId}/`
- Verify `.claude` symlink points to the correct tenant's `.claude/`
- Verify BB env vars are tenant-specific in queryOptions
- Existing single-tenant tests pass unchanged (default tenant)

---

### Phase 3: HTTP API Tenant Routing (*parallel with Phase 2*)

**3.1 Add tenant extraction middleware**
- File: `tools/src/server.ts`
  - Add `X-Tenant-Id` header extraction (with fallback to `"default"`)
  - Add `resolveTenantOrFail(settings, tenantId, res)` helper — returns 404 if unknown tenant
  - All job-creating endpoints extract tenantId and pass to `JobInput`
  - Job listing endpoints accept optional `?tenant=` query param to filter
  - Job detail/stream/resume/message endpoints: no tenant extraction needed (job ID is globally unique; validate tenant ownership if strict isolation desired)

**3.2 Webhook multi-tenant routing**
- File: `tools/src/server.ts` (webhook handler)
  - Current flow: verify HMAC → extract PR ID → find job → dispatch
  - New flow: extract PR ID → find job (global lookup) → read `job.tenantId` → resolve tenant config → verify HMAC against tenant's webhook secret
  - If no job found for PR, try verifying HMAC against each tenant's secret (for new PRs that haven't been mapped yet — but this shouldn't happen since agents create PRs via MCP tools which map them immediately)
  - Fallback: if only one tenant configured, use their secret (backward compat)

**3.3 OpenAPI spec update**
- File: `tools/src/openapi.ts`
  - Add `X-Tenant-Id` header parameter to all endpoints
  - Document tenant behavior

*Depends on: Phase 1 (tenantId on JobInput)*

**Verification:**
- Test: POST `/jobs/feature` with `X-Tenant-Id: acme` creates job with `tenantId: "acme"`
- Test: POST `/jobs/feature` without header creates job with `tenantId: "default"`
- Test: GET `/jobs?tenant=acme` returns only acme's jobs
- Test: webhook for a PR mapped to tenant "acme" validates against acme's webhook secret
- Test: webhook with unknown PR ID returns 200 (no-op, as today)

---

### Phase 4: CLI Tenant Support (*parallel with Phase 2-3*)

**4.1 Add `--tenant` global option**
- File: `tools/cli/index.ts`
  - Add global option: `.option('--tenant <id>', 'Tenant identifier', process.env.A5_TENANT ?? 'default')`
  - Pass tenant to all subcommands

- File: `tools/cli/commands/migrate.ts`, `tools/cli/commands/feature.ts`
  - Include `X-Tenant-Id` header in API requests
  - Include `tenantId` in body where applicable

- File: `tools/cli/commands/jobs.ts`, `tools/cli/commands/status.ts`, `tools/cli/commands/logs.ts`
  - Pass `?tenant=` query param to filter job listing by tenant
  - Job-specific commands (status/logs by jobId) don't need tenant — job ID is globally unique

- File: `tools/cli/http.ts`
  - Add default `X-Tenant-Id` header to all API requests from a global option

*Depends on: Phase 3 (server accepts X-Tenant-Id)*

**Verification:**
- `a5 --tenant acme feature --repo ...` dispatches a job with `tenantId: "acme"`
- `a5 jobs --tenant acme` shows only acme's jobs
- `A5_TENANT=acme a5 feature ...` works via environment variable
- `a5 jobs` with no tenant shows all jobs (admin view)

---

### Phase 5: Per-Tenant File Watcher (self-improvement isolation)

**5.1 Watcher multiplexing**
- File: `tools/src/watcher.ts`
  - Replace single `a5aiDir` watch with loop over `settings.tenants`
  - For each tenant: create a chokidar instance watching their `intelligenceDir`
  - `processChanges()` receives `tenantConfig` so it knows which repo to branch/commit/push in
  - Use the tenant's BB coder account for the self-improvement PR
  - Tag the PR with the tenant's reviewers (from tenant config or a `reviewers` field in TenantConfig)
  - Self-update jobs also carry `tenantId`

**5.2 Tenant config for self-improvement**
- File: `tools/src/config/settings.ts`
  - Add `intelligenceRepoSlug: string` to `TenantConfig` — the BitBucket repo slug for the tenant's intelligence repo (needed for PR creation)
  - Add `defaultReviewers?: string[]` to `TenantConfig` — who reviews self-improvement PRs

*Depends on: Phase 1 (TenantConfig), Phase 2 (tenant-aware runner)*

**Verification:**
- Modify a file in tenant A's intelligence dir → PR created in tenant A's repo with tenant A's BB credentials
- Modify a file in tenant B's intelligence dir → separate PR in tenant B's repo
- Tenant A's proposal doesn't appear in tenant B's PR

---

### Phase 6: Dashboard Multi-Tenancy

**6.1 Dashboard tenant filter**
- File: `tools/dashboard/src/pages/JobList.tsx`
  - Add tenant filter dropdown (populated from `/tenants` endpoint or hardcoded from config)
  - Pass `?tenant=` to job listing API
  - Show tenant badge on each job card

- File: `tools/dashboard/src/pages/JobDetail.tsx`
  - Show tenant ID in job header

- File: `tools/dashboard/src/types.ts`
  - Add `tenantId: string` to Job type

**6.2 Admin tenant list endpoint**
- File: `tools/src/server.ts`
  - Add `GET /tenants` endpoint returning list of configured tenant IDs (no credentials)

*Depends on: Phase 3 (API supports tenant filtering)*

**Verification:**
- Dashboard shows tenant filter
- Selecting a tenant shows only that tenant's jobs
- "All tenants" shows everything (admin view)

---

## Relevant files

- `tools/src/config/settings.ts` — Add `TenantConfig`, `tenants[]`, `resolveTenantConfig()`, `paths.tenantsDir`
- `tools/src/jobs/types.ts` — Add `tenantId` to `Job` and `JobInput`
- `tools/src/jobs/registry.ts` — Tenant-scoped Redis keys for listing, PR mapping stays global for webhook routing
- `tools/src/jobs/runner.ts` — Resolve `intelligenceDir` and `workingDir` from tenant config, create per-tenant clients, pass tenant-specific env vars
- `tools/src/prompt/builder.ts` — Accept `intelligenceDir` parameter instead of reading from global settings
- `tools/src/jobs/dispatcher.ts` — Pass `tenantId` through job creation; no structural change
- `tools/src/server.ts` — Extract `X-Tenant-Id` header, per-tenant webhook HMAC, `GET /tenants`
- `tools/src/watcher.ts` — Per-tenant chokidar instances, per-tenant self-improvement PRs
- `tools/src/tools/types.ts` — `ToolContext` gets tenant-specific clients (created by runner)
- `tools/src/index.ts` — Create watcher per tenant at startup
- `tools/cli/index.ts` — Global `--tenant` option
- `tools/cli/commands/*.ts` — Pass tenant header in API calls
- `tools/cli/http.ts` — Default `X-Tenant-Id` header
- `tools/config/settings.example.json` — Add `tenants` array example
- `tools/dashboard/src/types.ts` — Add `tenantId` to Job type
- `tools/dashboard/src/pages/JobList.tsx` — Tenant filter dropdown
- `tools/dashboard/src/pages/JobDetail.tsx` — Show tenant in header

## Verification

1. **Backward compat**: Run existing test suite with no tenants configured → all tests pass, everything uses "default" tenant
2. **Unit**: Registry tests with tenant-scoped listing, PR mapping, job creation
3. **Unit**: Runner tests verify `intelligenceDir` resolution from tenant config
4. **Unit**: Builder tests verify it loads from passed `intelligenceDir`, not global
5. **Integration**: Start two-tenant setup, dispatch jobs for each, verify working dir isolation (`{base}/{tenantId}/{jobId}/`), verify `.claude` symlinks point to correct tenant intelligence dirs
6. **Integration**: Verify webhook routes to correct job and validates against correct tenant's HMAC secret
7. **E2E**: Run a full feature job for tenant A, verify agents load tenant A's agents/workflows/memory
8. **E2E**: Verify self-improvement PR from tenant A goes to tenant A's intelligence repo
9. **Dashboard**: Verify tenant filter works, job detail shows tenant

## Decisions

- **Header-based tenant routing** (`X-Tenant-Id`) — simpler than path prefix, works with existing URL structure, easy to add JWT-based extraction later
- **Global PR→job mapping** — webhooks don't know the tenant; look up job globally, read tenantId from it
- **Config-file tenant registry** — sufficient for <50 tenants; can migrate to Redis-backed registry later
- **Default tenant fallback** — zero breaking changes; existing single-tenant deployments keep working
- **Per-job client creation** — simple and safe; BB/Loki/Tempo clients are stateless HTTP wrappers, cheap to create
- **Intelligence dir = git repo** — each tenant's intelligence is a separate git repo, enabling independent versioning and self-improvement PRs

## Scope boundaries

**Included:**
- Tenant isolation for intelligence, working dirs, credentials, Redis, webhooks, CLI, dashboard
- Backward-compatible default tenant
- Per-tenant self-improvement PRs

**Excluded (future):**
- Per-tenant billing/usage tracking
- Tenant provisioning API (create/delete tenants at runtime)
- Cross-tenant shared intelligence (e.g., a "base" intelligence layer that tenants inherit from)
- Per-tenant rate limiting or concurrency limits
- Tenant authentication (JWT/OAuth) — using header trust for now, add auth layer later
- Multi-region deployment

## Dependency Graph

```
Phase 1 (data model) ──┬── Phase 2 (runner + builder)  ── Phase 5 (watcher)
                        ├── Phase 3 (HTTP API)          ── Phase 6 (dashboard)
                        └── Phase 4 (CLI)
```

Phases 2, 3, and 4 can proceed in parallel once Phase 1 lands.
