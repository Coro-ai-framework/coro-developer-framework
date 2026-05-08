# Plan v1: Runner Core + Claude Provider Split

> **Status:** Proposed implementation plan. No code changes yet.
> **Scope:** Split the monolithic Claude-bound runner into a provider-neutral core + a Claude provider package + an assembled app. Build the provider SPI, the cross-provider session continuity model, and the provider-aware config/UX. Ship Claude as the only first-party provider in v1; v2 ([multi-provider-and-aggregators-v2.md](multi-provider-and-aggregators-v2.md)) ships Codex, Foundry, etc.
> **Backward compatibility:** None. Coro has no users yet.
> **Functional compatibility:** Every current end-user capability must still work after the refactor.

---

## 1. Why this plan exists

Today the runner is hardwired to Claude. Concretely:

- [packages/runner/src/jobs/runner.ts](../../packages/runner/src/jobs/runner.ts) imports the Claude SDK directly (`query`, `Query`, `SDKUserMessage`, `HookCallback`), reads `settings.claude.codingModel` to choose models, calls `query({ resume: sessionId, settingSources: ['project'], thinking: { type: 'adaptive' }, ... })`, parses Claude-shaped events, and computes cost from Claude's `total_cost_usd`.
- [packages/runner/src/jobs/dispatcher.ts](../../packages/runner/src/jobs/dispatcher.ts) keeps `Map<jobId, Query>` and injects live messages via `Query.streamInput()`.
- [packages/runner/src/mcp-server.ts](../../packages/runner/src/mcp-server.ts) wraps every tool with `tool()` from `@anthropic-ai/claude-agent-sdk` and returns `createSdkMcpServer(...)`.
- [packages/runner/src/claude-code-path.ts](../../packages/runner/src/claude-code-path.ts) and [packages/runner/src/runner/claude-login.ts](../../packages/runner/src/runner/claude-login.ts) own Claude CLI resolution + Claude OAuth login.
- [packages/runner/src/config/local-config.ts](../../packages/runner/src/config/local-config.ts) and [packages/runner/src/config/settings.ts](../../packages/runner/src/config/settings.ts) put Anthropic at the top of the config tree.
- [packages/runner/src/runner/server.ts](../../packages/runner/src/runner/server.ts) exposes `/config/anthropic/claude-login/*` and `/config/anthropic/generate-oauth-token`.
- [packages/dashboard/src/pages/Settings.tsx](../../packages/dashboard/src/pages/Settings.tsx) and [packages/dashboard/src/pages/Home.tsx](../../packages/dashboard/src/pages/Home.tsx) gate setup readiness on Anthropic credentials.

Goal: build a clean three-package architecture that lets us add another LLM provider (Codex, Azure Foundry, etc.) without touching core logic, and lets a single workflow run different providers on different phases. v1 finishes the split + ships Claude as a first-class provider. v2 adds more providers.

---

## 2. Target architecture

Three packages after the split:

```
@coro/runner-core
  Provider-neutral library. Phase orchestration, prompt building,
  intelligence resolver, state backends, MCP handler catalog,
  generic plugin contracts, provider SPI.
  ZERO dependency on @anthropic-ai/claude-agent-sdk.

@coro/runner-provider-claude
  Claude-only runtime. The ONLY package that imports the Claude SDK.
  Owns Claude CLI resolution, Claude login, Claude execution loop,
  Claude session control, Claude pricing, Claude hooks, Claude MCP
  bridge, Claude config schema, Claude HTTP route fragments,
  Claude dashboard UI fragments.

@coro/runner
  Assembled application. CLI, HTTP server, dashboard hosting,
  local + hybrid bootstrap, persisted config IO, bundled provider
  registry, plugin loader, cloud control plane, desktop sidecar
  contract.
```

**Hard rule (enforced by CI grep):** `@anthropic-ai/claude-agent-sdk` may only appear in `packages/runner-provider-claude/`.

**Bundled-only in v1.** No drop-in provider install path. No reuse of the SCM/tracker plugin loader for providers. Providers are statically registered at app bootstrap.

---

## 3. Provider SPI (the only thing core knows about LLMs)

Defined in `packages/runner-core/src/provider/`. Every provider package implements this interface and exports a factory.

```ts
export interface LlmProvider {
  // ── Identity ──────────────────────────────────────────────
  readonly id: string                            // 'claude'
  readonly displayName: string                   // 'Claude (Anthropic)'
  readonly capabilities: ProviderCapabilities

  // ── Lifecycle ─────────────────────────────────────────────
  init(ctx: ProviderInitContext): Promise<void>
  dispose(): Promise<void>

  // ── Auth + health ─────────────────────────────────────────
  describeAccount(): Promise<ProviderAccountInfo | null>
  healthCheck(): Promise<ProviderHealth>
  buildAuthEnv(phase: PhaseExecutionContext): NodeJS.ProcessEnv

  // ── Execution ─────────────────────────────────────────────
  executePhase(input: PhaseInput): AsyncIterable<NeutralEvent>
  sendUserMessage(jobId: string, text: string): Promise<void>
  interrupt(jobId: string): Promise<void>
  endSession(jobId: string): Promise<void>

  // ── Continuity ────────────────────────────────────────────
  supportsNativeContinuity(): boolean
  resumeSession(sessionId: string, input: PhaseInput): AsyncIterable<NeutralEvent>
  startFreshSession(packet: ContinuationPacket, input: PhaseInput): AsyncIterable<NeutralEvent>

  // ── MCP bridge ────────────────────────────────────────────
  buildMcpBridge(catalog: McpToolCatalog): ProviderMcpHandle

  // ── Cost + usage ──────────────────────────────────────────
  normalizeUsage(rawUsage: unknown): NeutralUsage
  computeCost(usage: NeutralUsage, modelId: string): number
}

export interface ProviderCapabilities {
  nativeSession: boolean       // can resume by sessionId
  multiAgentSubagents: boolean // can spawn parallel subagents natively
  preToolHooks: boolean        // can intercept tool calls before dispatch
  streamingInput: boolean      // can inject user msgs into a live stream
  mcpServers: boolean          // supports MCP server attachment
  thinking: boolean            // exposes a reasoning channel
  // v2 extends this with vision, audio, etc.
}

export type NeutralEvent =
  | { type: 'session_started'; sessionId: string }
  | { type: 'assistant_text'; text: string }
  | { type: 'assistant_thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; result: unknown; isError?: boolean }
  | { type: 'usage'; usage: NeutralUsage; reportedCostUsd?: number }
  | { type: 'phase_complete'; reason: 'finished' | 'interrupted' | 'error' }
  | { type: 'error'; error: { code: string; message: string } }

export interface NeutralUsage {
  inputTokens: number
  outputTokens: number
  // Claude only (kept for fidelity, ignored by other providers):
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  // Provider-specific extension bag for anything else:
  ext?: Record<string, number>
}
```

This SPI is the line in the sand. Anything that can't be expressed through it doesn't belong in core.

---

## 4. Cross-provider session continuity (decided in conversation)

**Rule:** Same provider as previous phase → use native continuity (`resume: sessionId`). Different provider → hard reset + provider-neutral **continuation packet**.

```ts
export interface ContinuationPacket {
  workflow: { path: string; phase: string; agentPath: string }
  job: { id: string; description: string; params: Record<string, unknown> }
  language?: string
  repo?: { remoteUrl: string; defaultBranch: string; workingBranch?: string }
  tracker?: TrackerPromptContext
  scm?: ScmPromptContext

  // The full system prompt for the new phase, with .claude/CLAUDE.md
  // explicitly inlined so providers without settingSources see it.
  systemPrompt: string

  // Compact history of completed phases:
  phaseHistory: Array<{
    phase: string
    provider: string
    model: string
    summary: string             // <= 1k chars, distilled by core from logs
    artifacts: ArtifactRef[]
  }>

  // Notes/insights/artifacts the agent has accumulated:
  openArtifacts: ArtifactRef[]
  insights: string[]
  todos: string[]
  acceptanceCriteria: string[]

  // Where we left off (capped recap, NOT raw transcript):
  recap: string

  // Tool catalog the new provider can call (names + descriptions only):
  tools: Array<{ name: string; description: string }>

  // Capability hints so the agent knows what NOT to attempt:
  providerHints: ProviderCapabilities
}
```

**What's excluded:** raw provider-native transcripts, provider session ids, provider-specific token counters. The packet is provider-neutral.

**Boundary detection:** at the start of each phase, core compares the phase's resolved `provider.id` to the `Job.lastPhaseProvider`. Same → call `provider.resumeSession(sessionByProvider[providerId], input)`. Different → call old provider's `endSession(jobId)`, build a `ContinuationPacket`, then call `newProvider.startFreshSession(packet, input)`.

**Always-maintained state:** `Job.phaseHistory[]` is updated every phase regardless of continuity mode, so a future provider switch never has to re-derive it.

---

## 5. Workflow schema (v1 changes)

Today: `phases[*].model: 'planning' | 'coding'` (cost tier only).

After v1:

```yaml
phases:
  - name: planning
    agent: agents/planner.md
    execution:
      provider: claude        # optional in v1; defaults to active provider
      tier: planning          # planning | coding (resolves to provider's profile)
      modelId: ~              # optional; if set, overrides tier
    subagents:
      - name: code-reviewer
        execution:
          provider: claude    # subagents inherit parent if omitted
          tier: coding
```

**Validator (new in core):** before a job runs, walks every phase and every subagent, looks up `(provider, capability)` in the registry, and rejects the workflow if a required capability is missing — e.g. a phase declares `subagents: [...]` but the resolved provider has `multiAgentSubagents: false`. v1 rejects at job start; v2 will support fallback chains.

---

## 6. Persisted config redesign

Old shape (deleted):

```jsonc
{
  "anthropic": { "method": "apiKey", "apiKey": "sk-ant-..." },
  "git": {...}, "tracker": {...}, "mcp": {...}, "paths": {...}
}
```

New shape:

```jsonc
{
  "providers": {
    "active": "claude",                    // default for jobs that don't pick one
    "installed": {
      "claude": { /* schema owned by claude provider package */ }
    },
    "profiles": {                          // shared "tier" → modelId mapping
      "planning": { "claude": "claude-opus-4-6" },
      "coding":   { "claude": "claude-sonnet-4-6" }
    }
  },
  "git": {...},
  "tracker": {...},
  "mcpServers": {...},
  "paths": {...},
  "cloud": {...},
  "plugins": {...}
}
```

**Provider config schema registration:** each provider package exports a Zod fragment; the app's config loader composes them under `providers.installed.<id>`. The Claude fragment is exactly the current `anthropic` block (`method`, `apiKey`, `oauthToken`, `account`), just relocated and renamed.

**Env fallback rules at bootstrap (`coro start`):** if no config exists, seed `providers.installed.claude.method` from `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` and set `providers.active = 'claude'`.

---

## 7. HTTP server redesign

Removed routes:

- `GET /config/anthropic/claude-login/status`
- `POST /config/anthropic/claude-login/start`
- `POST /config/anthropic/claude-login/callback`
- `POST /config/anthropic/generate-oauth-token`
- `GET /config/claude-code-mcps`

New provider-namespaced routes (each provider package contributes its own router):

```
GET  /providers
       → [{ id, displayName, capabilities, configured, healthy, account }]

GET  /providers/:id/status
POST /providers/:id/login/start          (provider-defined payload)
POST /providers/:id/login/callback       (provider-defined payload)
POST /providers/:id/actions/:actionId    (provider-defined verbs)
GET  /providers/:id/models               (used by v2; v1 returns profile defaults)
```

Claude provider's contributed router maps:

- `POST /providers/claude/login/start` → existing `claude-login start` flow
- `POST /providers/claude/login/callback` → existing callback flow
- `POST /providers/claude/actions/generate-oauth-token` → existing `claude setup-token` PTY flow
- `GET /providers/claude/local-mcps` → existing `claude-code-mcps` preview

`GET /config` and `PUT /config` stay, but the payload is the new provider-aware shape. The redact/restore dance moves to a per-provider redactor registered with the config schema.

---

## 8. Dashboard redesign

### 8.1 Settings page

Replace the single "Anthropic" tab with a **Providers** tab that:

- Lists each bundled provider as a card (icon, displayName, status pill, account summary, "Configure" button).
- The selected card opens an inline panel rendered by **provider-contributed React fragments**. Each provider package ships a `ui/` entry exporting `{ SettingsPanel, AccountSummary, StatusPill }`. The dashboard wires them via a small extension contract — providers cannot reach into the rest of the dashboard.
- Above the cards, a single "Active provider" selector controls `providers.active`.
- Below the cards, a "Model profiles" section maps tiers (`planning`, `coding`) to a per-provider modelId. v1 only renders Claude; v2 adds more.

The Claude `SettingsPanel` keeps every current capability: API key entry, Claude login flow, raw OAuth token entry, "Generate via `claude setup-token`" button, account display, Claude Code MCP inheritance preview/toggle, MCP-mode warnings.

Other tabs stay: **Git, Tracker, Plugins, MCP Servers, Paths**. Their copy is updated so they reference "the active LLM provider" instead of "Anthropic".

### 8.2 Home page

Replace `summariseConfig()` in [packages/dashboard/src/pages/Home.tsx](../../packages/dashboard/src/pages/Home.tsx). New rule:

```
Setup is complete when:
  - providers.active is set, AND
  - providers.installed[active] reports healthy=true, AND
  - git provider + credentials are configured.
```

The setup banner lists missing items by name (e.g., "Claude credentials", "Git credentials") instead of hardcoding "Anthropic credentials".

### 8.3 Job detail page

Per-phase rows show `{ phase, provider, model, costUsd }` instead of just `{ phase, model, costUsd }`. The aggregate cost view groups by provider in a small breakdown.

---

## 9. CLI redesign

`coro init`:

1. Prompt "Which LLM provider would you like to set up first?" with bundled provider ids.
2. Hand off to that provider's CLI fragment for auth (each provider exports an `initFlow()` callback).
3. Then prompt for SCM plugin + git creds (unchanged logic, new copy).
4. Persist using the new config shape.

`coro login`: unchanged in purpose (cloud auth), but stops seeding a placeholder `anthropic` block.

New `coro provider` command:

```
coro provider list
coro provider status <id>
coro provider login <id>
coro provider logout <id>
```

These delegate to provider-contributed CLI handlers. v1 only has `claude`.

---

## 10. State + DB changes

### 10.1 Job record additions

```ts
interface Job {
  // existing fields stay…
  sessionId?: string                                  // DEPRECATED, keep for one release for SQLite migration safety; new code uses sessionByProvider
  sessionByProvider?: Record<string, string>          // providerId → sessionId
  lastPhaseProvider?: string
  lastContinuationPacketRef?: string                  // sha256 + storage path
  phaseHistory: Array<{
    phase: string
    provider: string
    model: string
    summary: string
    artifacts: ArtifactRef[]
    startedAt: string
    finishedAt: string
  }>
  costByProvider?: Record<string, number>             // providerId → usd
  usageByProvider?: Record<string, NeutralUsage>      // providerId → totals
  // existing PhaseUsage[] stays, but each entry gets:
  //   provider: string
}
```

### 10.2 SQLite migration

Job is a JSON blob today. Add an indexed generated column so we can filter/aggregate:

```sql
ALTER TABLE jobs
  ADD COLUMN provider TEXT
  GENERATED ALWAYS AS (json_extract(data, '$.lastPhaseProvider')) VIRTUAL;
CREATE INDEX idx_jobs_provider ON jobs(provider);
```

A second virtual column exposes `costByProvider` JSON for dashboard aggregation queries. No data migration needed because it is virtual and reads from `data`.

### 10.3 Cloud (Postgres) migration

Drizzle migration that adds `provider TEXT NULL` (real, not virtual) populated by a write-time hook in the cloud backend. Index on `provider`. A `cost_by_provider JSONB` column for dashboards. Backfill is a no-op because there are no production rows.

---

## 11. Desktop changes

[packages/desktop-electron/src/runner-sidecar.ts](../../packages/desktop-electron/src/runner-sidecar.ts) currently passes the entire `process.env` to the runner subprocess. After v1:

- Replace blanket env passthrough with an explicit allowlist (`PATH`, `HOME`, `NODE_*`, `CORO_*`, plus the active provider's env vars resolved at launch time).
- Provider env vars are read from the OS keychain when available (macOS Keychain, Windows Credential Manager, libsecret). Fallback to plaintext config for first-run only.
- The packaged Claude SDK native binary stays bundled with the assembled app for v1. v2 considers per-provider optional bundles.
- `resolveDesktopResourceLayout()` and `validateDesktopResourceLayout()` get a new check: the active provider's runtime resources (e.g., the Claude CLI native package) must exist; if missing, sidecar startup fails fast with an actionable message.

---

## 12. Cloud control plane

Solo and hybrid both keep the same bootstrap. The cloud control plane needs:

- Per-team **provider credential storage** (encrypted, separate row per provider).
- Hybrid handshake exposes the team's configured providers + their credentials to the runner over the WebSocket transport.
- Job dispatch payload carries the resolved provider per phase so the runner doesn't have to call back to the cloud mid-job.

For v1 the cloud only stores Claude credentials, but the schema is provider-keyed from day one.

---

## 13. Test strategy

Three new test surfaces:

1. **Core provider contract tests.** A `FakeProvider` that exercises the SPI through `runner-core`'s phase orchestrator. These tests must pass with zero Claude code in scope.
2. **Claude provider conformance tests.** The same harness instantiated against `runner-provider-claude`. Covers auth modes, query execution, session resume, hooks, cost reporting, MCP bridge, OAuth token generation.
3. **App acceptance tests.** Boot the assembled app, hit `/providers`, `/config`, `/jobs`, drive a real workflow end-to-end with a mocked Claude API. Verify `Job.phaseHistory`, `costByProvider`, dashboard payloads.

Existing tests are split per the move map (§14.5).

---

## 14. The full move map

### 14.1 Move to `runner-core` unchanged

| From | To |
|---|---|
| [packages/runner/src/clients/](../../packages/runner/src/clients/) | `packages/runner-core/src/clients/` |
| [packages/runner/src/intelligence/](../../packages/runner/src/intelligence/) | `packages/runner-core/src/intelligence/` |
| [packages/runner/src/state/](../../packages/runner/src/state/) | `packages/runner-core/src/state/` |
| [packages/runner/src/tools/](../../packages/runner/src/tools/) | `packages/runner-core/src/tools/` |
| [packages/runner/src/prompt/](../../packages/runner/src/prompt/) | `packages/runner-core/src/prompt/` |
| [packages/runner/src/workflow-parser.ts](../../packages/runner/src/workflow-parser.ts) | `packages/runner-core/src/workflow-parser.ts` |
| [packages/runner/src/jobs/types.ts](../../packages/runner/src/jobs/types.ts) | `packages/runner-core/src/jobs/types.ts` |
| [packages/runner/src/jobs/creation.ts](../../packages/runner/src/jobs/creation.ts) | `packages/runner-core/src/jobs/creation.ts` |
| [packages/runner/src/jobs/plugin-preflight.ts](../../packages/runner/src/jobs/plugin-preflight.ts) | `packages/runner-core/src/jobs/plugin-preflight.ts` |
| [packages/runner/src/mcp-handlers.ts](../../packages/runner/src/mcp-handlers.ts) | `packages/runner-core/src/mcp/handlers.ts` |
| [packages/runner/src/plugins/types.ts](../../packages/runner/src/plugins/types.ts) | `packages/runner-core/src/plugins/types.ts` |
| [packages/runner/src/plugins/registry.ts](../../packages/runner/src/plugins/registry.ts) | `packages/runner-core/src/plugins/registry.ts` |
| [packages/runner/src/plugins/refs.ts](../../packages/runner/src/plugins/refs.ts) | `packages/runner-core/src/plugins/refs.ts` |

### 14.2 Split `jobs/runner.ts`

Today this 1700-line file does both phase orchestration and Claude execution. Split as follows.

**To `runner-core/src/jobs/phase-orchestrator.ts`:**

- `runJob(jobId)` outer phase loop, signals (cancel/abort/resume), intelligence resolution per phase, prompt builder calls, phase boundary detection (provider compare), continuation packet construction, `phaseHistory` writes, post-phase state sync.

**To `runner-core/src/jobs/continuation-packet.ts`:**

- `buildContinuationPacket(job, nextPhase, intelligenceDir, ...)` pure function.

**To `runner-provider-claude/src/query-executor.ts`:**

- The body of `query({...})`, the event loop that parses Claude `system|assistant|result` messages, MCP server attachment, hooks wiring.

**To `runner-provider-claude/src/model-selection.ts`:**

- `selectModel(phaseConf, settings)` — Claude's tier→model mapping.

**To `runner-provider-claude/src/auth-env.ts`:**

- `buildAnthropicAuthEnv(authConfig)` and `ensureClaudeConfigSymlink()`.

**To `runner-provider-claude/src/phase-hooks.ts`:**

- `buildPhaseHooks(opts)` PreToolUse safety enforcement.

**To `runner-provider-claude/src/pricing.ts`:**

- `derivePhaseCostUsd()` and any Claude-specific cost normalization.

**To `runner-provider-claude/src/subagents.ts`:**

- `buildSubagentDefinitions(...)` MultiAgent shape.

### 14.3 Split `jobs/dispatcher.ts`

**To `runner-core/src/jobs/dispatcher.ts`:**

- Job event queue, `activeJobs: Map<jobId, ActiveJobHandle>`, dispatch/resume/cancel state machine, message injection facade `sendMessage(jobId, text)` that delegates to the active provider.

**To each provider package:** the actual session controller (`SessionController` interface) implementing `sendUserMessage`, `interrupt`, `endSession`. Claude's implementation wraps `Query.streamInput()` and `Query.interrupt()`.

### 14.4 Split `mcp-server.ts`

**To `runner-core/src/mcp/catalog.ts`:**

- `McpToolCatalog` type: `{ name, description, schema, handler }[]` built from the existing handler set. Pure JSON, zero SDK imports.

**To `runner-provider-claude/src/mcp-bridge.ts`:**

- `buildClaudeMcpServer(catalog)` wraps each entry with the Claude SDK's `tool()` and returns `createSdkMcpServer(...)`.

### 14.5 Test moves

| From | To |
|---|---|
| `packages/runner/tests/runner/*` | Split: orchestrator → core, query/event-loop → provider-claude, end-to-end → app |
| `packages/runner/tests/mcp/mcp-handlers.test.ts` | `runner-core/tests/mcp/handlers.test.ts` |
| `packages/runner/tests/mcp/mcp-server.test.ts` | `runner-provider-claude/tests/mcp-bridge.test.ts` |
| `packages/runner/tests/unit/claude-login.test.ts` | `runner-provider-claude/tests/login.test.ts` |
| `packages/runner/tests/unit/anthropic-auth-env.test.ts` | `runner-provider-claude/tests/auth-env.test.ts` |
| `packages/runner/tests/unit/local-config.test.ts` | rewritten in app package against new schema |
| `packages/runner/tests/integration/*` | stay in app package |
| `packages/runner/tests/cloud/*` | stay in app package |

### 14.6 Delete

- [packages/runner/src/plugins/deprecation.ts](../../packages/runner/src/plugins/deprecation.ts) — translation layer, not needed without backward compat.
- All `/config/anthropic/*` route handlers in [packages/runner/src/runner/server.ts](../../packages/runner/src/runner/server.ts) (replaced by provider-namespaced equivalents in the Claude package).

---

## 15. Phased delivery

Each phase ends with a green build and a working end-to-end smoke test. No phase is "done" without that.

### Phase 0 — Architecture freeze (1 PR, planning only)

**Tasks**

- 0.1 Approve §3 SPI signature and capability matrix.
- 0.2 Approve §4 cross-provider continuity policy and continuation packet schema.
- 0.3 Approve §5 workflow schema delta.
- 0.4 Approve §6 persisted config shape.
- 0.5 Approve §10 DB migration approach.
- 0.6 Lock the package names (`@coro/runner-core`, `@coro/runner-provider-claude`, `@coro/runner`).

**Exit:** this document merged. No code touched.

### Phase 1 — Provider SPI + Job + workflow schema (1 PR)

Add the new types in the existing `packages/runner` package (no new package yet). This unblocks every later phase without forcing a workspace reshuffle.

**Tasks**

- 1.1 Create `packages/runner/src/provider/` with: `types.ts` (LlmProvider, capabilities, NeutralEvent, NeutralUsage), `registry.ts` (in-memory provider registry), `session-controller.ts`.
- 1.2 Create `packages/runner/src/runtime/continuation-packet.ts` with the `ContinuationPacket` type and pure builder.
- 1.3 Add `sessionByProvider`, `lastPhaseProvider`, `phaseHistory`, `costByProvider`, `usageByProvider` to [packages/runner/src/jobs/types.ts](../../packages/runner/src/jobs/types.ts). Keep old `sessionId` for one release.
- 1.4 Extend [packages/runner/src/workflow-parser.ts](../../packages/runner/src/workflow-parser.ts): `phase.execution = { provider?, tier?, modelId? }`. Old `phase.model` keeps parsing as `tier`.
- 1.5 Add `validateWorkflowAgainstCapabilities(workflow, registry)` to core; called by the dispatcher before a job runs.
- 1.6 Build a `FakeProvider` test double that implements the SPI; add `tests/provider/fake-provider.test.ts`.

**Exit:** SPI compiles, unit tests pass, no behavior change in runtime.

### Phase 2 — Config redesign (1 PR)

**Tasks**

- 2.1 Rewrite [packages/runner/src/config/local-config.ts](../../packages/runner/src/config/local-config.ts) around §6 shape. Provider config schemas are registered via a `ProviderConfigRegistry`. Claude's schema is hardcoded in this PR; later moved to the Claude package.
- 2.2 Rewrite [packages/runner/src/config/settings.ts](../../packages/runner/src/config/settings.ts): replace `Settings.claude` with `Settings.providers` + per-provider runtime settings.
- 2.3 Rewrite [packages/runner/src/runner/index.ts](../../packages/runner/src/runner/index.ts) `buildSettingsFromLocal()`.
- 2.4 Rewrite [packages/runner/src/runner/server.ts](../../packages/runner/src/runner/server.ts) `/config` GET/PUT around the new shape; redactor lives in the provider config registry.
- 2.5 Update `coro init` and `coro login` for new shape.
- 2.6 Update [packages/dashboard/src/pages/Settings.tsx](../../packages/dashboard/src/pages/Settings.tsx) and [packages/dashboard/src/pages/Home.tsx](../../packages/dashboard/src/pages/Home.tsx) to consume the new `/config` payload. (UI is still hardcoded to Claude in this PR; provider extension contract comes in Phase 6.)
- 2.7 Update `/config/anthropic/*` callers in the dashboard to keep working against the still-present routes; the routes themselves move in Phase 6.

**Exit:** the app boots, configures Claude, runs a job. Config file on disk is in the new shape.

### Phase 3 — In-place runtime seam extraction (1 PR)

Refactor inside the existing `packages/runner` so `jobs/runner.ts`, `jobs/dispatcher.ts`, `mcp-server.ts` use the SPI internally — but Claude is still a one-and-only inline provider. No package moves yet.

**Tasks**

- 3.1 Implement `ClaudeProvider implements LlmProvider` inline at `packages/runner/src/provider/claude/`. Methods are thin delegates to the existing functions.
- 3.2 Rewrite `jobs/runner.ts` `runJob()` to call `provider.executePhase(...)` (or `resumeSession` / `startFreshSession`) instead of `query(...)`. Event loop becomes provider-agnostic, consuming `NeutralEvent`.
- 3.3 Rewrite `jobs/dispatcher.ts` `activeQueries` → `activeJobs: Map<jobId, ActiveJobHandle>` where the handle holds `{ providerId, sessionController }`. `sendMessage()` delegates to `controller.sendUserMessage()`.
- 3.4 Rewrite `mcp-server.ts` to two pieces in the same file: a `buildMcpToolCatalog(ctx)` (provider-neutral) and `ClaudeProvider.buildMcpBridge(catalog)` (uses SDK).
- 3.5 Implement the provider boundary detection in the orchestrator (always same-provider in this PR, but the branch exists).
- 3.6 Implement Claude's `normalizeUsage` / `computeCost` and stop reading raw Claude usage in core.

**Exit:** the runner runs Claude through the SPI. No external behavior change. CI grep does not yet enforce the no-Claude-in-core rule.

### Phase 4 — Provider capability gates + continuation packet path (1 PR)

**Tasks**

- 4.1 Wire the workflow validator (1.5) into job dispatch.
- 4.2 Implement boundary detection real path: when `Job.lastPhaseProvider !== resolved.provider.id`, build a `ContinuationPacket` and call `startFreshSession`. Until v2 ships a second provider this path is exercised only by tests using `FakeProvider`.
- 4.3 Update the prompt builder to **always** inline `.claude/CLAUDE.md` into the system prompt (rename the on-disk file path to a neutral one, e.g., `agent-runtime.md`, but keep the existing file as a symlink for the Claude SDK's `settingSources` pickup).
- 4.4 Generalize Claude-only references in base intelligence: agents/coder.md `request_new_session` becomes a capability-gated tool; if `provider.capabilities.nativeSession === false`, the tool is omitted from the catalog and the agent prompt drops the instruction line.
- 4.5 Implement `costByProvider`, `usageByProvider` writes in the orchestrator after each phase.
- 4.6 Implement `phaseHistory.summary` distillation: a pure function in core that takes the phase's `NeutralEvent` log and writes a 1k-char summary using a deterministic template (last 3 assistant texts + tool-call counts + final outcome). No LLM call — it must be cheap.

**Exit:** end-to-end test where a workflow has two phases on `FakeProvider` and the second phase receives a fully-formed continuation packet.

### Phase 5 — Package split (1 PR, mostly mechanical)

**Tasks**

- 5.1 Create `packages/runner-core/` with package.json, tsconfig, vitest config. No Claude SDK dep.
- 5.2 Create `packages/runner-provider-claude/` with package.json, tsconfig, vitest config. Sole owner of the Claude SDK dep.
- 5.3 Move files per §14.1, §14.2, §14.3, §14.4 with `git mv` so history is preserved.
- 5.4 Move tests per §14.5.
- 5.5 Update every import path. Use a TypeScript-aware codemod.
- 5.6 Add a CI check: `rg @anthropic-ai/claude-agent-sdk packages/runner-core packages/runner` exits non-zero.
- 5.7 In `packages/runner/src/runner/index.ts` startup: instantiate `runner-core`'s ProviderRegistry, register `createClaudeProvider()` from the Claude package, then continue.

**Exit:** all three packages build standalone. App package boots and runs a Claude job.

### Phase 6 — Provider-contributed UI/CLI/HTTP (1 PR)

**Tasks**

- 6.1 Define UI extension contract: each provider package may export `ui/` with `{ SettingsPanel, AccountSummary, StatusPill, initFlow }`. The dashboard imports them via a manifest the assembled app builds at compile time (no runtime plugin loading in v1).
- 6.2 Define HTTP extension contract: each provider exports `registerHttpRoutes(app, ctx)` which the assembled server calls during startup. Routes must live under `/providers/<id>/...`.
- 6.3 Define CLI extension contract: each provider exports `registerCliCommands(program)` which `cli/index.ts` calls.
- 6.4 Move the Claude-specific UI fragments out of `Settings.tsx` into `runner-provider-claude/ui/SettingsPanel.tsx`. Settings page becomes a generic provider list that renders contributed fragments.
- 6.5 Move `/config/anthropic/*` routes into `runner-provider-claude/src/http-routes.ts` under `/providers/claude/...`. Dashboard updated to use new URLs.
- 6.6 Move Claude's `coro init` prompts into `runner-provider-claude/cli/init-flow.ts`. The shared `coro init` calls `provider.initFlow()` for the chosen provider.
- 6.7 Add `coro provider list|status|login|logout` shared commands.

**Exit:** Settings page, CLI, and HTTP server are provider-extensible. Adding a v2 provider requires zero changes to the assembled app's UI/CLI/server code.

### Phase 7 — DB migrations + cost reporting UX (1 PR)

**Tasks**

- 7.1 Add SQLite virtual columns + index per §10.2.
- 7.2 Add Postgres real column + index + JSONB cost column per §10.3 with a Drizzle migration.
- 7.3 Update [packages/dashboard/src/pages/JobDetail.tsx](../../packages/dashboard/src/pages/JobDetail.tsx) to render per-phase provider + cost-by-provider breakdown.
- 7.4 Update jobs list filters to support filtering by provider.
- 7.5 Sweep dashboard copy: "Anthropic" → "LLM provider" / specific provider name.

**Exit:** dashboard shows per-provider cost. SQL queries by provider use the index.

### Phase 8 — Desktop credential routing (1 PR)

**Tasks**

- 8.1 Replace blanket env passthrough in [packages/desktop-electron/src/runner-sidecar.ts](../../packages/desktop-electron/src/runner-sidecar.ts) with explicit allowlist + per-provider env.
- 8.2 Add OS keychain integration (macOS Keychain + Windows Credential Manager + libsecret on Linux) behind a single `secretsStore` module.
- 8.3 Update [packages/desktop-electron/scripts/prepare-resources.mjs](../../packages/desktop-electron/scripts/prepare-resources.mjs) to copy both the assembled app and bundled provider native deps into the resources folder.
- 8.4 Extend `validateDesktopResourceLayout()` to verify the active provider's runtime resources exist.
- 8.5 Smoke test: packaged DMG launches, sidecar boots, dashboard reachable, Claude job runs end-to-end.

**Exit:** packaged desktop app works with the new architecture and stricter credential handling.

### Phase 9 — Cloud control plane (1 PR)

**Tasks**

- 9.1 Add `provider_credentials` table (Postgres) keyed by `(team_id, provider_id)` with encrypted blob.
- 9.2 Update the WebSocket handshake (hybrid) to include configured providers + credentials in the runner-bound bootstrap message.
- 9.3 Update the dispatch payload to include resolved `(provider, modelId)` per phase.
- 9.4 Add `provider` column to the cloud `jobs` table (already covered in Phase 7) + populate it from dispatch metadata.
- 9.5 Update cloud dashboards (cost charts, job filters) to be provider-aware.

**Exit:** hybrid mode works with provider-aware credential routing. Cloud dashboards show per-provider data.

### Phase 10 — Documentation + release hardening (1 PR)

**Tasks**

- 10.1 Rewrite [README.md](../../README.md) around the three-package model.
- 10.2 Rewrite [CLAUDE.md](../../CLAUDE.md) (developer-facing) for the new repo structure.
- 10.3 Rewrite [docs/architecture.md](../architecture.md) with the provider architecture section.
- 10.4 Rewrite [docs/agent-host-spec.md](../agent-host-spec.md) around the assembled app + SPI.
- 10.5 Rewrite [docs/desktop-shell.md](../desktop-shell.md) for the new packaged layout.
- 10.6 Add `packages/runner-core/README.md`, `packages/runner-provider-claude/README.md`.
- 10.7 Write a "Provider authoring guide" — the contract a third-party provider (or v2 Codex/Foundry) must implement.
- 10.8 Update [docs/plans/multi-provider-and-aggregators-v2.md](multi-provider-and-aggregators-v2.md) to "in progress / next" status.

**Exit:** docs match implementation. Repository is ready for v2.

---

## 16. Acceptance criteria for v1

A user with **only** Claude configured can:

1. Run `coro start`, land in the dashboard, configure Claude (any of API key / login / OAuth token / token generation), pass setup readiness, and run a job end-to-end.
2. Resume, cancel, and live-message-inject a Claude job.
3. See per-phase cost broken down by provider in the job detail page (always "claude" in v1).
4. Use the desktop app, including the packaged DMG.
5. Use hybrid mode against the cloud control plane.

A developer can:

1. Build all three packages independently with `pnpm -F @coro/runner-core build`, etc.
2. Run all three test suites independently and together.
3. Inspect a job that has two phases on `FakeProvider` and see a fully-formed `ContinuationPacket` between them (test fixture).
4. Add a new provider package by following [docs/provider-authoring.md](../provider-authoring.md) without modifying core, app, or Claude packages.
5. Verify CI fails if `@anthropic-ai/claude-agent-sdk` is imported anywhere outside `packages/runner-provider-claude/`.

---

## 17. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Continuation packet under-specified — agent loses critical context on provider switch | Treat the packet as a versioned schema. Write a "round-trip" test where Phase A on FakeProvider deposits artifacts/insights/TODOs and Phase B on FakeProvider asserts they all appear in the packet. Iterate until the test is exhaustive. |
| `settingSources: ['project']` removal breaks Claude prompts | Don't remove it for Claude; keep it set in the Claude provider's `executePhase`. Inline `.claude/CLAUDE.md` into the system prompt for *all* providers including Claude (defensive duplication is harmless because Claude dedupes via cache control). |
| MCP bridge regressions because the wrapper moves | Snapshot every tool's serialized schema before the move; assert byte-equal after. |
| Dashboard regression because Settings.tsx is rewritten | Take Playwright screenshots before the Phase 6 PR, compare after. Add e2e test for every current Claude auth flow. |
| Desktop app stops working after Phase 8 env allowlist | Ship Phase 8 as its own PR with packaged smoke test in CI; don't bundle with anything else. |
| DB migration drift between SQLite and Postgres | Generate the migration from a single source-of-truth schema definition. Run both backends in CI for the same suite. |
| Live message injection regression in dispatcher rewrite | Add an integration test that asserts `sendMessage` reaches the agent within a bounded number of events. |

---

## 18. Out of scope for v1

- Any provider other than Claude. v2 ships Codex + first aggregator.
- Per-phase model selection beyond `(provider, tier)`. v2 adds explicit `modelId` and ordered preference chains.
- Drop-in third-party provider plugins. v3.
- Auto-translation of legacy config. There is no legacy config to translate.
- Cross-provider tool standardization beyond the existing core MCP catalog.
- Cross-provider transcript replay. The continuation packet replaces it.
