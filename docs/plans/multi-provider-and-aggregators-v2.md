# Plan v2: Multi-Provider + Aggregator Support

> **Status:** Proposed implementation plan. Depends on v1 ([runner-core-provider-split-v1.md](runner-core-provider-split-v1.md)) being merged.
> **Scope:** Make Coro work fully with no Anthropic account. Ship Codex (or any direct provider) and at least one aggregator (Azure AI Foundry recommended) so a single workflow can mix providers per phase, and so users get a unified model picker spanning many catalogs.
> **Backward compatibility:** None. v2 builds on v1's provider SPI without re-litigating it.

---

## 1. What "fully works" means for a Codex-only user

After v2 a user with no Claude account and only Codex configured can:

1. Run `coro start`, configure Codex through the dashboard (or CLI), and pass setup readiness with no "missing Anthropic credentials" warning.
2. Run the standard `job` workflow end-to-end on Codex: planning → coding → review → evaluation, opening a real PR.
3. See cost broken down per phase with real Codex pricing.
4. Use desktop, hybrid mode, plugins, MCP servers — same surface as a Claude-only user.

The same is true for any other v2-bundled direct provider, and for any model exposed through a v2-bundled aggregator.

---

## 2. The two provider archetypes

v1 defined `LlmProvider`. v2 introduces a clean distinction between two implementation styles:

### 2.1 Direct providers

One package = one vendor SDK = one auth surface = a small number of model ids.

Examples: `@coro/runner-provider-claude` (already shipped in v1), `@coro/runner-provider-codex`, `@coro/runner-provider-openai`, `@coro/runner-provider-gemini`.

A direct provider:

- Implements `LlmProvider` directly.
- Returns 1–10 entries from `listModels()`.
- Owns its own auth UI/CLI fragment.
- Owns its own pricing table (small, hand-curated).

### 2.2 Aggregator providers

One package fronts many models routed through a single upstream gateway. The user signs in once and gets access to a catalog of models from multiple families.

Examples: `@coro/runner-provider-foundry` (Azure AI Foundry), `@coro/runner-provider-bedrock` (AWS), `@coro/runner-provider-vertex` (GCP), `@coro/runner-provider-openrouter`.

An aggregator provider:

- Extends a shared `AggregatorProvider` base in core that handles catalog refresh, per-model capability lookup, per-deployment connection management.
- Returns 10s–100s of entries from `listModels()`, refreshed from the upstream.
- Owns multiple **connections** (e.g., dev + prod Foundry endpoints, multiple AWS regions).
- Per-model capability matrix is curated, not auto-detected.
- Pricing prefers upstream-reported cost; falls back to a curated local table.

Both archetypes implement the **same** v1 `LlmProvider` SPI. The aggregator base is just a helper.

---

## 3. SPI extensions on top of v1

```ts
export interface LlmProvider {
  // … v1 surface stays …

  // ── Model catalog ─────────────────────────────────────────
  listModels(): Promise<ModelDescriptor[]>
  resolveModel(modelId: string): ModelDescriptor | null
  refreshModelCatalog?(): Promise<void>           // aggregator-only

  // ── Connections (aggregator-only, optional) ───────────────
  listConnections?(): ConnectionDescriptor[]
  setActiveConnection?(name: string): void

  // ── Capability lookup is now per-model, not per-provider ──
  capabilitiesForModel(modelId: string): ProviderCapabilities
}

export interface ModelDescriptor {
  id: string                          // 'foundry/azure-openai/gpt-5'
  displayName: string                 // 'GPT-5 (Foundry / EastUS)'
  family: string                      // 'gpt-5' | 'claude-opus' | 'gemini-2.5'
  provider: string                    // 'foundry'
  connection?: string                 // aggregator deployment name
  contextWindow: number
  capabilities: ProviderCapabilities
  pricing: { inputPer1k: number; outputPer1k: number; cachedInputPer1k?: number }
  notes?: string
}

export interface ConnectionDescriptor {
  name: string                        // user-given, e.g. 'eastus-prod'
  endpoint?: string
  region?: string
  configured: boolean
  healthy?: boolean
}
```

**Capability matrix is per-(provider, model)**, not per-provider. Foundry hosts both Claude and GPT — they have different capabilities and need separate matrix entries.

---

## 4. Workflow schema (v2 changes)

v1 introduced `phase.execution = { provider?, tier?, modelId? }`. v2 generalizes selection:

```yaml
phases:
  - name: planning
    agent: agents/planner.md
    execution:
      # Ordered preference chain. The resolver picks the first
      # entry the user has configured + healthy.
      prefer:
        - { provider: foundry, modelId: gpt-5 }
        - { provider: claude,  tier: planning }
        - { provider: codex,   modelId: o4-mini }
      # If none of the prefer entries are available:
      fallback: error               # error | downgrade | skip-phase

  - name: coding
    agent: agents/coder.md
    execution:
      # Family-based selection — picks any available model whose
      # family matches.
      prefer:
        - { family: gpt-5-class }
        - { family: claude-sonnet }
      requireCapabilities: [ multiAgentSubagents ]
    subagents:
      - name: code-reviewer
        execution:
          inherit: true             # use parent phase's resolved model
```

**Resolver rules:**

1. Walk `prefer` in order; return the first entry that resolves to a configured + healthy + capability-compatible model.
2. If none match and `fallback: downgrade`, drop `requireCapabilities` and retry once. If still none, escalate per `fallback` policy.
3. Subagents default to `inherit: true`; explicit subagent execution declarations are validated against the parent's resolved provider when `inherit: false`.

**Validator:** runs before job dispatch. Refuses to start if any phase has no resolvable model under the user's current configuration. The dashboard surfaces this as a workflow setup gap with a "configure Foundry" / "configure Codex" link.

---

## 5. Codex parity workstream (the headline deliverable)

This is the single most user-visible v2 outcome. Built first because it stress-tests the v1 SPI for a non-Claude provider before aggregators add a second layer of complexity.

### 5.1 New package: `@coro/runner-provider-codex`

Implements the v1 `LlmProvider` SPI for OpenAI's Codex / Responses API.

**Auth:** API key + optional org id + optional base URL (for Azure-fronted OpenAI). UI fragment renders three fields and a "Test connection" button. CLI fragment prompts for the same three.

**Execution:** uses `openai` Node SDK. `executePhase` / `startFreshSession` / `resumeSession`:

- `startFreshSession(packet, input)`: posts the continuation packet's `systemPrompt` as the system message, the packet's `recap` + `tools catalog` as the first user message, then streams. This is the every-phase code path because Codex doesn't expose a server-side session resume in a way Coro can rely on.
- `resumeSession(sessionId, input)`: same as above but uses the cached "messages so far" array stored in `Job.providerState.codex.messages`. Codex provider state holds the message history client-side and replays it. This is the same-provider continuity path.
- `supportsNativeContinuity()`: `true`. Even though Codex doesn't have a server session id, the provider treats client-side message history as native continuity from core's perspective.

**Subagents (the hard part).** Codex has no MultiAgent feature. v2 implements **synthetic subagents in the provider**:

- When core dispatches a subagent, the Codex provider opens a separate conversation thread (separate message array), drives it to completion, captures the result, then returns control to the parent phase.
- Sequential dispatch only (no parallel).
- The subagent's MCP tools are bound to the same in-process MCP server.
- `provider.capabilities.multiAgentSubagents = true` for Codex despite the absence of native MultiAgent — the contract is "the workflow author can declare subagents and they will run", not "the provider has parallelism".
- A separate capability `parallelSubagents` exists for workflows that explicitly need parallelism; Codex reports `false`. v1's `code-reviewer` subagent is sequential anyway.

**Pre-tool safety hooks.** Codex has no PreToolUse hook. The Codex provider implements equivalent enforcement at its own tool-call boundary: before the SDK dispatches a tool call, the provider runs the same safety predicates Claude's hooks use (path allow/deny, shell-command policy). Same code path, just invoked from the provider instead of from the SDK runtime.

**Cost.** Codex doesn't return `total_cost_usd`. The provider's `computeCost(usage, modelId)` reads from a hand-curated table of `{ modelId → inputPer1k, outputPer1k }`. Updated by hand as OpenAI publishes new prices.

**MCP bridge.** Codex supports tool-use via the OpenAI tools schema. The bridge converts the v1 `McpToolCatalog` entries into OpenAI tool definitions and round-trips tool calls / tool results.

**Streaming input.** OpenAI streams are uni-directional; you can't inject a new user message into a live stream. The Codex provider implements `sendUserMessage(jobId, text)` by:

1. Cancelling the current stream via `AbortController`.
2. Appending the new user message to the conversation history.
3. Re-issuing the request from where it left off, preserving any in-flight tool results.

Reports `capabilities.streamingInput = true` because the user-visible behavior matches Claude.

### 5.2 Intelligence cleanup

v1 already inlined `.claude/CLAUDE.md` into the system prompt for all providers. v2 must finish the job:

- Generalize agent prompt language: replace "you are Claude" / "use the Skill tool" / "call `request_new_session`" with provider-neutral instructions. Where a Claude-only tool is mentioned, gate the line on capabilities ("If you have access to `request_new_session`, …").
- Audit [packages/intelligence-base/layer/agents/](../../packages/intelligence-base/layer/agents/) and [packages/intelligence-base/layer/.claude/skills/](../../packages/intelligence-base/layer/.claude/skills/). Change wording so a model with no prior knowledge of Claude can follow the instructions.
- Rename `.claude/CLAUDE.md` to `.coro/agent-runtime.md` (provider-neutral path), with `.claude/CLAUDE.md` kept as a symlink so Claude's `settingSources: ['project']` still picks it up. Prompt builder reads from the new path.

### 5.3 Dashboard / CLI / setup-readiness

- `coro init` lists Codex among the bundled provider options at "Which LLM provider would you like to set up first?".
- Settings page renders the Codex provider tile via the v1 UI extension contract. Codex's `SettingsPanel` has API key field, optional org id, optional base URL, "Test connection" button.
- Home setup banner is satisfied when `providers.active = 'codex'` and Codex reports healthy. No Anthropic-specific copy.
- Job detail page shows `provider: codex` and `model: codex/o4-mini` (or whichever) in the per-phase rows.

### 5.4 Smoke test that defines "Codex parity is done"

A scripted end-to-end test that:

1. Boots the runner with `providers.installed.codex` configured and Claude *not* configured.
2. Posts a job with the standard `job` workflow against a real (or recorded) Codex API.
3. Asserts every phase completes (planning, coding, code-reviewer subagent, review, evaluation).
4. Asserts a PR is opened on a test repo.
5. Asserts `Job.costByProvider.codex > 0` and `Job.lastPhaseProvider === 'codex'`.
6. Asserts no log line contains "Anthropic" or "Claude" (because no Claude code path was hit).

When this test is green, "Codex-only user fully works" is true.

---

## 6. Aggregator workstream

Built second, after Codex proves the SPI is non-Claude-friendly.

### 6.1 Shared base: `AggregatorProvider`

Lives in `@coro/runner-core` as an abstract class that implements the boilerplate every aggregator shares:

```ts
export abstract class AggregatorProvider implements LlmProvider {
  // Supplied by subclass:
  protected abstract fetchUpstreamCatalog(connection: ConnectionDescriptor): Promise<RawModel[]>
  protected abstract toModelDescriptor(raw: RawModel, conn: ConnectionDescriptor): ModelDescriptor
  protected abstract executeForModel(model: ModelDescriptor, input: PhaseInput): AsyncIterable<NeutralEvent>

  // Provided by base:
  async listModels(): Promise<ModelDescriptor[]> { /* returns cached union across connections */ }
  async refreshModelCatalog(): Promise<void> { /* re-fetches per connection, persists */ }
  resolveModel(id: string): ModelDescriptor | null { /* lookup by id */ }
  capabilitiesForModel(id: string): ProviderCapabilities { /* curated map by family */ }
  // executePhase / startFreshSession / resumeSession dispatch to executeForModel.
}
```

Catalog cache:

- Persisted to `~/.coro/cache/providers/<id>/catalog-<connection>.json` keyed by hash of the upstream response.
- Refresh on demand (dashboard "Refresh catalog" button) and on a TTL (default 24h).
- The dashboard pins the catalog version into the workflow validator so a workflow's resolved model can be reproduced even if the catalog later changes.

### 6.2 First aggregator: `@coro/runner-provider-foundry`

Azure AI Foundry exposes many model families through a single endpoint. Picked first because it covers OpenAI, Llama, Mistral, and others through a single auth surface, which is the exact "no-Anthropic-account user" story.

**Auth + connections:**

- A Foundry **connection** is `{ name, endpoint, apiKey, deploymentName? }`.
- Multiple connections per user supported (dev/staging/prod, multi-region).
- Default connection is auto-selected if there is exactly one; otherwise the workflow / user picks.

**Catalog:**

- `fetchUpstreamCatalog(conn)` calls the Foundry deployments endpoint for that connection.
- Each returned deployment becomes one `ModelDescriptor` whose id is `foundry/<connection>/<deployment>`.
- Family is inferred from the deployment's `model.publisher` + `model.name` via a curated table (`gpt-5`, `gpt-4o`, `llama-4`, `mistral-large`, etc.).

**Capabilities per family:** curated table maintained in the package. Keys are `(publisher, family)` → `ProviderCapabilities`. Reviewed by hand, not auto-detected.

**Execution:** uses Azure SDK or raw `fetch` against the deployment endpoint. Accepts the same OpenAI tool-use protocol Codex uses, which is also Foundry's native shape.

**Pricing:** Foundry returns usage but not cost. `computeCost` uses a curated per-family pricing table. Where the user provides explicit per-deployment pricing overrides in their config, those win.

### 6.3 Second aggregator (stretch): `@coro/runner-provider-bedrock`

Same template as Foundry. Different upstream auth (AWS access key + region + IAM). Catalog comes from `bedrock:ListFoundationModels`.

Treated as a stretch goal — ship if v2 has bandwidth, otherwise punt to v2.5.

### 6.4 Workflow + dashboard implications

- **Workflow validator** must resolve aggregator model ids against the cached catalog, not against a static enum. If the aggregator's cache is stale and the workflow's preferred id is no longer available, the validator surfaces it as a "refresh catalog or pick fallback" warning.
- **Dashboard model picker** (new component on the workflow editor and the new run page) presents a unified, searchable list of `(provider, model)` pairs the user has configured access to, grouped by provider, with capability badges. Aggregator entries show the connection name.
- **Per-phase run UI** lets a user override the workflow's preferred model on dispatch — same picker, scoped to the chosen phase.

---

## 7. Connection management

A new concept v2 introduces and the dashboard must surface.

A **connection** is a configured pointer to a specific upstream deployment within an aggregator provider. Direct providers always have exactly one (implicit) connection.

Persisted shape:

```jsonc
{
  "providers": {
    "installed": {
      "foundry": {
        "connections": {
          "eastus-prod": { "endpoint": "https://...", "apiKeyRef": "secret://...", "deploymentDefault": "gpt-5" },
          "westeu-dev":  { "endpoint": "https://...", "apiKeyRef": "secret://...", "deploymentDefault": "gpt-4o" }
        },
        "active": "eastus-prod"
      },
      "claude": { /* one implicit connection, schema unchanged from v1 */ }
    }
  }
}
```

UI: each aggregator tile expands to show its connections. Add / edit / remove / set default connection. Refresh catalog per connection.

CLI: `coro provider connection list <providerId>`, `coro provider connection add <providerId> <name>`, `coro provider connection set-default <providerId> <name>`.

---

## 8. Cost + usage normalization

v1's per-provider `computeCost` and `normalizeUsage` are sufficient. v2 adds:

- **Per-model pricing** in addition to per-provider, because aggregator providers carry many models with very different prices.
- **Per-deployment pricing override** for users with negotiated rates (text field in the Foundry connection editor).
- **Aggregate dashboard widgets:** "spend by provider" and "spend by model" pie charts, last-7-day cost trends.
- **Budget alerts (stretch):** a per-provider monthly budget with a webhook + dashboard notification when crossed.

---

## 9. Auth + secrets

v1 introduced OS keychain integration in desktop. v2 generalizes:

- All provider credentials are stored in the keychain when available, plaintext config only as a fallback.
- A new `secrets` config block tracks references (`secret://provider/<id>/<connection>/<field>`) instead of raw values. The runner resolves them at job dispatch time.
- For hybrid mode the cloud control plane stores per-team secrets server-side (already covered by v1 §12), v2 just adds per-connection scoping for aggregators.

---

## 10. Provider authoring guide (deliverable doc)

A markdown guide added at `docs/provider-authoring.md` (written in v2 because v2 has two patterns to demonstrate — direct + aggregator). Covers:

1. Picking direct vs aggregator base.
2. Implementing the SPI methods (with code skeletons).
3. Capability matrix conventions.
4. Pricing table conventions.
5. UI extension contract: how to write a `SettingsPanel.tsx`.
6. CLI extension contract.
7. HTTP route contract (must live under `/providers/<id>/...`).
8. Testing: the conformance harness from `runner-core` that any provider must pass.
9. Bundling: how a provider package gets wired into the assembled `@coro/runner` app.
10. Distribution policy (v2: bundled-only, v3: drop-in plugins).

---

## 11. Phased delivery

Each phase ends with a green build and a working end-to-end smoke test. Phases are sized so each maps to one PR.

### Phase 0 — v2 architecture freeze (planning only)

- 0.1 Approve §3 SPI extensions.
- 0.2 Approve §4 workflow resolver semantics (preference chains, fallback policies).
- 0.3 Approve §6.1 `AggregatorProvider` shape.
- 0.4 Approve §7 connection model and persisted shape.
- 0.5 Approve which aggregators are in scope: Foundry definitely; Bedrock as stretch.
- 0.6 Confirm "Codex parity smoke test" (§5.4) is the v2 gate.

**Exit:** this document merged with no open questions.

### Phase 1 — Codex provider, minimum viable

- 1.1 Create `packages/runner-provider-codex/` with package.json, tsconfig, vitest.
- 1.2 Implement the v1 SPI minimally: API key auth only, single model id, no subagents, no streamingInput.
- 1.3 Capability matrix: `{ nativeSession: true, multiAgentSubagents: false, preToolHooks: true, streamingInput: false, mcpServers: true, thinking: false }`.
- 1.4 Curated pricing table for current Codex models.
- 1.5 MCP bridge: convert core `McpToolCatalog` to OpenAI tools schema.
- 1.6 Register Codex in the assembled app's provider registry.
- 1.7 Settings page: Codex tile renders a basic API-key panel via v1's UI extension contract.
- 1.8 `coro init` lists Codex; `coro provider login codex` works.
- 1.9 Smoke test: a single-phase test workflow runs end-to-end on Codex.

**Exit:** a Codex-only user can run a one-phase workflow.

### Phase 2 — Codex parity hard parts

- 2.1 Synthetic subagents in the Codex provider (sequential dispatch). Update capability to `multiAgentSubagents: true, parallelSubagents: false`.
- 2.2 Tool-call boundary safety hooks (replicate Claude's PreToolUse predicates).
- 2.3 Streaming input via abort + replay; update capability to `streamingInput: true`.
- 2.4 Cancellation via `AbortController`; wire into `provider.interrupt(jobId)`.
- 2.5 Codex `startFreshSession(packet)` formally tested with a multi-phase workflow whose phases all run on Codex (proves v1 same-provider path works on a non-Claude provider too).
- 2.6 Codex `startFreshSession(packet)` from a Claude phase (proves v1 cross-provider path works).
- 2.7 Codex pricing edge cases: cached input pricing, fine-tuned model surcharges.

**Exit:** every Claude capability has a Codex analog, gated behind capability flags where it has to be.

### Phase 3 — Intelligence generalization

- 3.1 Audit [packages/intelligence-base/layer/agents/](../../packages/intelligence-base/layer/agents/) for Claude-only references; rewrite provider-neutrally.
- 3.2 Audit [packages/intelligence-base/layer/.claude/skills/](../../packages/intelligence-base/layer/.claude/skills/) and [packages/intelligence-base/layer/.claude/CLAUDE.md](../../packages/intelligence-base/layer/.claude/CLAUDE.md) for the same.
- 3.3 Rename `.claude/CLAUDE.md` to `.coro/agent-runtime.md` with `.claude/CLAUDE.md` kept as a symlink. Update prompt builder to read the new path.
- 3.4 Capability-gated tool catalog: `request_new_session`, MultiAgent shorthand, Skill tool only listed when the resolved provider supports them.
- 3.5 Add a "intelligence linter" test suite that runs the standard `job` workflow's phase prompts through every bundled provider's capability matrix and asserts no instruction references an unsupported tool.

**Exit:** a Codex-only user runs the standard `job` workflow end-to-end, opens a real PR.

### Phase 4 — Workflow resolver + preference chains

- 4.1 Replace the v1 single-resolution `phase.execution` with the v2 `prefer[]` + `requireCapabilities` + `fallback` semantics.
- 4.2 Implement the resolver in `runner-core` with deterministic precedence rules.
- 4.3 Update the workflow validator to resolve every phase's preference chain at job start; refuse jobs with no resolvable phase.
- 4.4 Update `Job` record to store the resolved `(provider, modelId, connection?)` per phase, captured at dispatch time so a re-dispatch of the same job uses the same model even if the user reconfigures providers mid-job.
- 4.5 Update the standard `job` workflow's phases to declare preference chains spanning multiple providers; first preference is the user's `providers.active`, fallbacks are sensible cross-provider equivalents.

**Exit:** a workflow with mixed-provider preference chains runs and resolves correctly under different user configurations.

### Phase 5 — Aggregator base + Foundry

- 5.1 Add `AggregatorProvider` abstract class to `runner-core` with catalog cache, connection management, default model resolution.
- 5.2 Create `packages/runner-provider-foundry/` and implement against `AggregatorProvider`.
- 5.3 Foundry connection management UI: the Foundry tile expands to a connection list with add / edit / remove / set-default + "Refresh catalog".
- 5.4 Foundry CLI: `coro provider connection ...` shared commands plus Foundry-specific overrides.
- 5.5 Catalog cache + version pinning per workflow.
- 5.6 Foundry capability matrix per family (GPT-5, GPT-4o, Llama-4, Mistral-Large, etc.).
- 5.7 Foundry pricing table per family with per-deployment override.

**Exit:** a Foundry-only user can configure a connection, see all available models in the dashboard model picker, run a workflow on any of them.

### Phase 6 — Dashboard model picker + per-phase override

- 6.1 New `<ModelPicker />` component used by the workflow editor and the new run dialog.
- 6.2 Searchable, grouped by provider, with capability badges.
- 6.3 Per-phase override on the new-run dialog: a user can pick a different model for any phase before dispatch.
- 6.4 Job detail per-phase row shows the resolved `(provider, model, connection?)` plus the originally preferred chain (for debug).
- 6.5 Cost dashboard widgets: spend by provider + spend by model.

**Exit:** a user can compose mixed-provider workflows from the dashboard without editing YAML.

### Phase 7 — Connections + secrets generalization

- 7.1 Move all provider credentials behind `secret://...` references in the persisted config.
- 7.2 Keychain-backed `secretsStore` (introduced in v1 desktop work) becomes the default for all providers, not just Claude.
- 7.3 Cloud control plane gains per-team, per-provider, per-connection secret storage.
- 7.4 Hybrid handshake updated to ship per-phase resolved credentials (and only those credentials) to the runner.

**Exit:** no plaintext secrets in `~/.coro/config.json` for any provider, on any platform.

### Phase 8 — Bedrock (stretch)

- 8.1 Create `packages/runner-provider-bedrock/`.
- 8.2 AWS auth (access key + region + IAM role assumption).
- 8.3 Catalog from `bedrock:ListFoundationModels`.
- 8.4 Pricing from a curated per-family table.

**Exit (stretch):** a Bedrock-only user can run a workflow.

### Phase 9 — Provider authoring guide + docs

- 9.1 Write [docs/provider-authoring.md](../provider-authoring.md) covering both archetypes.
- 9.2 Update [README.md](../../README.md), [CLAUDE.md](../../CLAUDE.md), [docs/architecture.md](../architecture.md) to describe v2 architecture.
- 9.3 Mark v1 and v2 plans as "delivered" in this docs/plans directory; archive them under `docs/plans/delivered/` (don't delete — they are the canonical "why we built it this way" record).

**Exit:** a contributor can add a third-party provider package by following the guide alone.

---

## 12. Acceptance criteria for v2

A user with **only** Codex configured can:

1. Configure Codex through the dashboard, pass setup readiness with no "Anthropic missing" warning.
2. Run the standard `job` workflow end-to-end on Codex; PR opens against a test repo.
3. See cost broken down per phase with non-zero Codex pricing.
4. Use desktop, hybrid mode, plugins, MCP servers, live message injection, cancellation.
5. Resume a Codex job after restart via the same-provider continuity path.

A user with **Foundry only** configured can:

1. Configure one or more Foundry connections.
2. See every Foundry-deployed model in the dashboard model picker.
3. Run the standard `job` workflow on any Foundry model.
4. Refresh the catalog and see new deployments without restarting the runner.

A user with **Claude + Codex + Foundry** all configured can:

1. Compose a workflow whose planning phase prefers Foundry GPT-5, coding phase prefers Claude Sonnet, and review phase prefers Codex.
2. Watch the runner switch providers between phases via the v1 continuation packet path.
3. See per-provider cost breakdown in the job detail page.
4. Override any phase's model on dispatch via the model picker.

A developer can:

1. Add a new direct provider package by following [docs/provider-authoring.md](../provider-authoring.md) without modifying core, app, or any other provider.
2. Add a new aggregator provider by extending `AggregatorProvider` and implementing three methods.
3. Run the conformance harness against any new provider and see it pass.

---

## 13. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Codex synthetic subagents diverge subtly from Claude MultiAgent and break workflow assumptions | The intelligence linter (Phase 3.5) runs the standard `job` workflow against every bundled provider's capability matrix. Any subagent semantic divergence shows up as a failing test. |
| Foundry catalog drift breaks workflows that pinned model ids | Catalog version pinning per workflow + dashboard "Refresh catalog" button. Validator surfaces stale-catalog warnings before dispatch. |
| Per-model capability matrix becomes stale or wrong | Curated, hand-maintained, with a unit test per family that asserts the curated matrix matches a known-good fixture. New families have to be reviewed in PR before they ship. |
| Workflow preference chains hide bugs ("works in CI because Claude is configured, fails in prod because Foundry isn't") | Validator runs per environment; CI runs the standard workflow with each bundled provider as the *only* configured provider, in a matrix. A workflow that doesn't resolve under any one bundled provider fails CI. |
| Pricing tables fall out of date | A `provider --print-pricing` command + a dashboard banner when prices are older than 90 days. |
| Cross-provider phase handoff loses context the agent needs | The v1 continuation packet schema is versioned. v2 adds a "round-trip parity" test per provider pair: run Phase A on provider X, switch to Phase B on provider Y, assert the agent's final output references context that came only from the packet. |
| Aggregator auth complexity (AWS IAM, Azure AD) blows up the auth UI | Each aggregator owns its own `SettingsPanel`. Foundry's panel is a connection list; AWS panel is a credentials profile picker. Generic dashboard code stays small. |
| Streaming input via abort+replay wastes tokens | Codex provider tracks token cost of the cancelled segment and surfaces it in the per-phase usage breakdown (`usage.ext.cancelledRetryTokens`). |
| Synthetic subagent infinite loop | Hard cap on subagent depth (default 1) + per-subagent token cap (default same as parent's remaining budget / 2). |

---

## 14. Out of scope for v2

- Drop-in third-party provider plugins (v3).
- Auto-discovery of upstream models without curated capability matrix.
- Cross-provider tool standardization beyond the existing core MCP catalog.
- Provider marketplace UI with install/uninstall.
- Multi-region failover within a single phase.
- Per-user per-team budget enforcement (only dashboard alerts).
- Fine-tuning / custom model training surfaces.

---

## 15. v3 preview (informational only)

After v2 lands, the natural v3 surface area is:

- **Drop-in provider plugins** loaded from `~/.coro/plugins/providers/<id>/` exactly like the existing SCM/tracker plugin loader.
- **Provider marketplace** in the dashboard.
- **Per-user routing policies** ("always prefer cheapest", "always prefer fastest", "always prefer my org's approved providers").
- **Cross-provider observability** with shared trace ids spanning a job's mixed-provider phases.

These are not commitments; they are listed so that v2 design choices don't accidentally close the door on them. In particular, the v2 SPI extensions (catalog, capability-per-model, connections) are sufficient for v3's drop-in plugins without further changes.
