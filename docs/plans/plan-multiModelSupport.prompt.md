# Plan: Multi-Model Support (Non-Anthropic Agent Runners)

## TL;DR

Make the A5 Agent Host run non-Anthropic models (GPT-4o, Gemini, etc.) as agent executors without changing a single line of the intelligence layer — workflows, agents, memory, skills, and `.claude/CLAUDE.md` stay exactly as they are. The only thing that changes is the **runtime** that executes those instructions.

The coupling to Anthropic is entirely in three places: the `query()` call that spawns Claude Code CLI, the SDK wrappers around MCP tool registration, and eight built-in tools (`Read/Write/Edit/Bash/Glob/Grep/Skill/Agent`) that the CLI provides natively. Abstracting those three things is the entire project.

---

## Architecture

```
Current:
  runner.ts  →  query()  →  Claude Code CLI (cli.js)  →  [Built-in tools + MCP tools]

Target:
  runner.ts  →  IModelRunner  →  ClaudeCodeRunner  →  query() + CLI (unchanged)
                             →  OpenAIRunner      →  OpenAI Chat API + MCP tool loop
                             →  GeminiRunner      →  Gemini API + MCP tool loop
```

All three runners receive the **same system prompt** assembled by `prompt/builder.ts`. The intelligence files (`agents/*.md`, `workflows/*.md`, `memory/*.md`, `.claude/skills/`) require zero changes — they are plain Markdown that any model can follow.

### What stays completely unchanged

- `agents/*.md`, `workflows/*.md`, `memory/*.md` — already flow through `builder.ts` into the system prompt
- `.claude/skills/*/SKILL.md` — becomes an MCP tool (see Phase 2), content unchanged
- All 30 business logic MCP tools in `mcp-handlers.ts` — use `@modelcontextprotocol/sdk` (already a transitive dep) and are model-agnostic
- The entire server, dispatcher, registry, webhook, and client layer

### What changes

| File | Change |
|---|---|
| `tools/src/jobs/runner.ts` | Extract `query()` call + stream loop into `ClaudeCodeRunner`; call via `IModelRunner` interface |
| `tools/src/mcp-server.ts` | Add 6 built-in replacement tools (`file_read`, `file_write`, `file_edit`, `file_glob`, `file_grep`, `read_skill`) |
| `tools/src/claude-code-path.ts` | Becomes Claude-runner-specific; moved to `runners/claude.ts` |
| `tools/src/prompt/builder.ts` | Inject `.claude/CLAUDE.md` into system prompt for non-Claude runners (1 conditional) |
| `tools/src/config/settings.ts` | Add `llm.provider` field; rename `claude.*` → `llm.*` |
| `tools/package.json` | Add `openai`; optionally `@google/genai` |

---

## Steps

### Phase 1: Runner Interface & ClaudeCodeRunner (foundation)

**1.1 Define `IModelRunner` and normalized event types**
- New file: `tools/src/runners/types.ts`
  - `IModelRunner` interface: `run(prompt: string, options: RunnerOptions): AsyncIterable<RunnerEvent>`
  - `RunnerOptions`: everything currently in `queryOptions` — `systemPrompt`, `model`, `cwd`, `mcpServer`, `env`, `maxTurns`, `sessionId?`
  - `RunnerEvent` union: `{ type: 'session_start', sessionId: string }` | `{ type: 'text', content: string }` | `{ type: 'thinking', content: string }` | `{ type: 'tool_call', name: string, input: unknown }` | `{ type: 'usage', inputTokens: number, outputTokens: number, cacheReadInputTokens: number, cacheCreationInputTokens: number }` | `{ type: 'done', stopReason: string }`
  - `ConversationMessage` type for session history (role + content blocks) — needed for non-Claude resume

**1.2 Extract `ClaudeCodeRunner`**
- New file: `tools/src/runners/claude.ts`
  - Move `resolveClaudeCodeCliPath` / `ensureClaudeCodeCliExecutable` from `claude-code-path.ts` into this file (or keep `claude-code-path.ts` and import from it)
  - `ClaudeCodeRunner` implements `IModelRunner`
  - `run()` calls `query()` from `@anthropic-ai/claude-agent-sdk` with the same `queryOptions` shape as today
  - Stream loop translates SDK events to `RunnerEvent` (same logic as today's for-await block in `runner.ts`)

**1.3 Refactor `runner.ts` to use the interface**
- File: `tools/src/jobs/runner.ts`
  - Add `createRunner(provider: string, settings: Settings): IModelRunner` factory function
  - Replace the `query()` call and stream for-await block with: `for await (const event of runner.run(prompt, runnerOptions))`
  - Map `RunnerEvent` types to existing log/token-accumulation logic (same behavior, different entry point)
  - The existing `queryImpl` injection seam in `RunJobOptions` stays — tests already mock at this level and don't need to change

*Depends on: nothing. ClaudeCodeRunner wraps existing behavior, no behavior change.*

**Verification:**
- All existing tests in `tests/runner/runner.test.ts` pass unchanged — `queryImpl` mock still works
- Manual: run a migration job with `provider: 'claude'` — behavior identical to today

---

### Phase 2: Built-in Tool Replacements in MCP Server

*(parallel with Phase 1)*

The Claude Code CLI provides `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `Skill`, and `Agent` natively. Non-Claude runners get none of these. Implement the safe subset as MCP tools — Claude runs can use them too, improving testability.

**2.1 File tools**
- File: `tools/src/mcp-server.ts`
  - `file_read(path: string): string` — reads a file relative to `cwd`. Validates path stays within `cwd` (no `../` traversal).
  - `file_write(path: string, content: string): void` — writes/creates a file relative to `cwd`. Creates parent directories.
  - `file_edit(path: string, oldStr: string, newStr: string): void` — string replacement in a file. Fails if `oldStr` not found or matches more than once.
  - `file_glob(pattern: string): string[]` — glob within `cwd`, returns relative paths.
  - `file_grep(pattern: string, path?: string, isRegex?: boolean): { file: string, line: number, content: string }[]` — grep within `cwd` or a specific file.

**2.2 Skill tool**
- File: `tools/src/mcp-server.ts`
  - `read_skill(skillName: string): string` — reads `.claude/skills/{skillName}/SKILL.md` from the intelligence directory (`a5aiDir`). Returns the full content. This replaces the Claude Code built-in `Skill` tool.
  - The `intelligenceDir` needed to resolve the skill path must be in `ToolContext` (it's already `settings.paths.a5aiDir` today; add it explicitly to `ToolContext`).

**2.3 Subagent tool (deferred)**
- The `Agent` built-in (spawns subagents defined in workflow phase config) is complex — defer to a follow-up. Non-Claude runners simply won't support phases with `subagents` in the workflow YAML until this is implemented.

**2.4 Per-runner `allowedTools` list**
- File: `tools/src/runners/claude.ts`
  - Claude runner keeps `allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Skill', 'mcp__a5__*', ...]` (unchanged)
- File: `tools/src/runners/openai.ts` (Phase 3)
  - Non-Claude runner uses `allowedTools: ['mcp__a5__*']` — all tools go through MCP including file ops

*Depends on: Phase 1 (ToolContext shape may need `intelligenceDir`)*

**Verification:**
- Unit test each tool: path traversal attempt returns error, not file contents
- Unit test `read_skill('golang-conventions')` returns the SKILL.md content
- Manually invoke `file_read` via an MCP client to confirm it works

---

### Phase 3: OpenAI Runner

*(depends on Phase 1)*

**3.1 Add OpenAI SDK**
- File: `tools/package.json`
  - Add `"openai": "^4.x"` to dependencies

**3.2 Implement `OpenAIRunner`**
- New file: `tools/src/runners/openai.ts`
  - `OpenAIRunner` implements `IModelRunner`
  - Uses `openai.chat.completions.create()` with `stream: true` and `tools` array built from the MCP server's tool list
  - MCP tool loop: on `tool_calls` in the streamed response, call each tool via the MCP server's in-process transport, collect results, and continue the conversation
  - `run()` manages the full tool-use loop until the model stops calling tools or `maxTurns` is reached
  - Emits `RunnerEvent` normalized events

**3.3 Session resume for non-Claude runners**
- When a webhook resumes a parked job, the Claude runner uses `sessionId` to resume the conversation. OpenAI has no stateful session concept.
- Add `conversationHistory: ConversationMessage[]` to the `Job` type (in `types.ts`) — only populated for non-Claude runners
- `OpenAIRunner.run()`: on resume, prepend `job.conversationHistory` before the new `pendingPrompt`
- After each phase, `OpenAIRunner` appends the full turn history to `job.conversationHistory` and syncs to Redis
- Claude runner leaves `conversationHistory` empty (sessions are managed by Claude Code internally)

**3.4 Reasoning mode**
- OpenAI o-series models (`o3`, `o4-mini`) use `reasoning_effort` instead of `temperature`. Gemini 2.5 Pro uses `thinking_config`.
- Add optional `reasoningMode?: 'default' | 'high'` to `RunnerOptions`
- Each runner maps this to its provider's native parameter

*Depends on: Phase 1 (IModelRunner), Phase 2 (file/skill tools in MCP)*

**Verification:**
- Run a feature job end-to-end with `provider: 'openai'` against a test repo
- Verify MCP tools are called correctly: `mcp__a5__log`, `file_read`, `read_skill`
- Park a job (via `await_event`), trigger a webhook, verify `conversationHistory` is replayed correctly
- Check `a5 logs` output looks coherent across the resume boundary

---

### Phase 4: Settings & Configuration

*(parallel with Phase 3)*

**4.1 Rename and extend settings**
- File: `tools/src/config/settings.ts`
  - Rename `settings.claude` → `settings.llm`
  - Add `provider: 'claude' | 'openai' | 'gemini'` to `LlmSettings`
  - Add `openaiApiKey?: string` and `geminiApiKey?: string` to `LlmSettings`
  - Keep `planningModel` and `codingModel` (now provider-specific model names, e.g., `gpt-4o` or `gemini-2.5-pro`)
  - Update all references to `settings.claude.*` → `settings.llm.*`

**4.2 Environment variable names**
- Add `LLM_PROVIDER`, `OPENAI_API_KEY`, `GEMINI_API_KEY` env var overrides
- Keep `ANTHROPIC_API_KEY` working (maps to `llm.apiKey` when `provider: 'claude'`)
- Keep `CLAUDE_PLANNING_MODEL` / `CLAUDE_CODING_MODEL` as aliases for backward compat; add `LLM_PLANNING_MODEL` / `LLM_CODING_MODEL`

**4.3 `.claude/CLAUDE.md` injection for non-Claude runners**
- File: `tools/src/prompt/builder.ts`
  - Add: if `settings.llm.provider !== 'claude'`, read `.claude/CLAUDE.md` from `a5aiDir` and prepend it as the first section of the system prompt
  - When `provider === 'claude'`, continue loading it via `settingSources: ['project']` (unchanged)

**4.4 Update `settings.example.json`**
- File: `tools/config/settings.example.json`
  - Add `llm.provider`, `llm.openaiApiKey`, example model names per provider

*Depends on: Phase 1 (runner factory reads `settings.llm.provider`)*

**Verification:**
- `settings.ts` unit tests pass with renamed fields
- `builder.test.ts`: assert `.claude/CLAUDE.md` appears in system prompt when provider is `'openai'`
- `builder.test.ts`: assert `.claude/CLAUDE.md` does NOT appear in system prompt when provider is `'claude'`

---

### Phase 5: Gemini Runner (optional, post-MVP)

*(depends on Phase 3 pattern)*

**5.1 Add Gemini SDK**
- File: `tools/package.json`
  - Add `"@google/genai": "^0.x"`

**5.2 Implement `GeminiRunner`**
- New file: `tools/src/runners/gemini.ts`
  - Follows same pattern as `OpenAIRunner`
  - Uses `@google/genai` `generateContentStream()` with `tools` array from MCP server
  - Maps `thinking_config: { thinkingBudget }` for reasoning mode
  - Emits normalized `RunnerEvent`

*Depends on: Phase 3 (OpenAI runner establishes the non-Claude pattern)*

---

## Relevant Files

- `tools/src/jobs/runner.ts` — extract `query()` call + stream loop into `ClaudeCodeRunner`; replace with `IModelRunner.run()` call; add `createRunner()` factory
- `tools/src/mcp-server.ts` — add `file_read`, `file_write`, `file_edit`, `file_glob`, `file_grep`, `read_skill` tools
- `tools/src/claude-code-path.ts` — absorbed into `tools/src/runners/claude.ts`
- `tools/src/prompt/builder.ts` — add `.claude/CLAUDE.md` injection for non-Claude providers
- `tools/src/config/settings.ts` — rename `claude.*` → `llm.*`, add `provider` + provider API keys
- `tools/package.json` — add `openai`, optionally `@google/genai`
- New `tools/src/runners/types.ts` — `IModelRunner`, `RunnerEvent`, `ConversationMessage`
- New `tools/src/runners/claude.ts` — `ClaudeCodeRunner` wrapping existing `query()` behavior
- New `tools/src/runners/openai.ts` — `OpenAIRunner` with MCP tool loop
- `tools/config/settings.example.json` — document new `llm.*` fields

---

## Verification

1. `tests/runner/runner.test.ts` passes unchanged — the `queryImpl` injection seam abstracts over the runner
2. New unit tests: `tests/unit/runners.test.ts` — mock `IModelRunner.run()` for each runner type
3. New unit tests: `tests/unit/mcp-builtins.test.ts` — path traversal rejection, `read_skill` happy path
4. `tests/unit/builder.test.ts` — `.claude/CLAUDE.md` injection logic for non-Claude providers
5. End-to-end: run a feature job with `provider: 'openai'` against a test repo and verify the agent reads files, loads a skill, and calls `mcp__a5__log`
6. Webhook resume: park a job, trigger the webhook, verify `conversationHistory` is replayed and the agent continues coherently

---

## Decisions

- **Intelligence files are not touched.** Workflows, agents, memory, and skills are plain Markdown. They work for any model without changes.
- **Claude behavior is unchanged.** The `ClaudeCodeRunner` wraps `query()` exactly as today. No regression risk for Claude runs.
- **`bash_exec` and `Agent` (subagent spawning) are explicitly deferred.** They're high-complexity/risk tools. Non-Claude runners simply cannot use workflow phases that require them until follow-up work.
- **Session resume via `conversationHistory` replay** is the approach for non-Claude runners — simple, Redis-native, no new infrastructure.
- **Phase 5 (Gemini) is post-MVP.** OpenAI runner (Phase 3) establishes the pattern. Gemini follows without architectural changes.

---

## Further Considerations

1. **Subagent spawning (`Agent` tool):** The Claude Code CLI's `Agent` built-in spawns subagents as defined in the workflow YAML `subagents:` block. For non-Claude runners, this requires implementing a recursive `run_subagent` MCP tool that creates a nested runner, runs it to completion, and returns the result. Not in scope for MVP but needed before non-Claude runners can handle migration workflows (which use subagents in the analysis phase).

2. **Cost tracking per provider:** `PhaseUsage.costUsd` is currently calculated from Anthropic's token pricing. Each runner must implement its own cost calculation based on provider pricing. Consider adding a `calculateCost(model, inputTokens, outputTokens): number` function per runner, and moving the cost lookup table out of the runner into a `pricing.ts` file.

3. **Model names in workflow YAML:** Today `model: planning` and `model: coding` are provider-agnostic discriminators that map to the configured model names. This design already supports multi-model — no changes needed to the workflow files themselves. However, a workflow could add `provider: openai` at the phase level in the future if per-phase provider routing is ever needed.
