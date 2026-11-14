# @coro-ai/intelligence-base

The **base intelligence layer** that ships with every Coro install.

It contains the company-agnostic markdown that defines what every Coro
runner can do out of the box. The layout is Claude Code's native one, so
the same files work in a plain Claude Code session (see
[Using this layer without Coro](#using-this-layer-without-coro)):

```
layer/
├── AGENTS.md                 ← Entry point for Copilot / AGENTS.md readers
└── .claude/
    ├── CLAUDE.md             ← Portable rules, loaded natively by Claude Code
    ├── coro/
    │   └── RUNTIME.md        ← Coro-only runtime contract (injected by the runner)
    ├── agents/               ← Generic agent role definitions (Claude Code subagents)
    ├── commands/coro/        ← Generic workflows, one slash command per file
    ├── skills/               ← On-demand skills bundled with the platform
    │   ├── feature-planning/
    │   ├── feature-testing/
    │   ├── golang-conventions/
    │   ├── dotnet-conventions/
    │   └── self-improvement-guide/
    └── memory/               ← Empty memory templates (tenants populate)
```

**Nothing in this package is company-specific.** Anything that mentions a
particular company, BitBucket workspace, observability host, or migration
story belongs in a *tenant overlay* (Phase 3+), not here.

## Public API

```ts
import {
  BASE_LAYER_NAME,
  BASE_LAYER_VERSION,
  LAYER_FILES,
  getBaseLayerRoot,
  pathInBaseLayer,
} from '@coro-ai/intelligence-base'

getBaseLayerRoot()           // → /abs/path/to/packages/intelligence-base/layer
pathInBaseLayer('claudeMd')  // → /…/layer/.claude/CLAUDE.md
pathInBaseLayer('runtimeMd') // → /…/layer/.claude/coro/RUNTIME.md
```

The runner uses this to find the base layer at job-prep time. The
intelligence resolver stacks tenant + repo overlays on top of these files.

## Layering model (recap)

```
┌──────────────────────────────────────────────────────────┐
│ Repo overlay        repo/.coro/                          │
├──────────────────────────────────────────────────────────┤
│ Tenant overlay      tenant remote / cloud blob           │
├──────────────────────────────────────────────────────────┤
│ Base intelligence   @coro-ai/intelligence-base/layer/  ← this package
└──────────────────────────────────────────────────────────┘
```

Every layer uses the same native layout (the repo overlay nests it under
`.coro/`). Conflict resolution: last-wins for `.claude/agents/`,
`.claude/commands/coro/` and `.claude/skills/`; concatenated for
`.claude/CLAUDE.md`, `.claude/coro/RUNTIME.md` and `.claude/memory/`. The
resolver materialises the merged tree into a per-job `_intelligence/`
directory that the runner points the SDK at.

## How Coro and Claude Code share these files

Three conventions let one set of files serve both:

- **The runtime contract is separate.** `.claude/CLAUDE.md` holds only what
  is true for any agent. The rules that assume Coro's MCP tools, sandbox and
  checkpoints are in `.claude/coro/RUNTIME.md`, which Claude Code never
  loads. The runner injects it at the top of every prompt.
- **Standalone blocks.** Text that only helps outside Coro (the
  tool-substitution table, the phase-by-phase instructions in the portable
  workflows, a pointer line in each agent) is fenced between
  `<!-- standalone:start -->` and `<!-- standalone:end -->`, each marker
  alone on its own line. The resolver removes these blocks, so a Coro prompt
  is unchanged. Do not write the full marker in prose.
- **A selective `.claude/` for the SDK.** During a Coro phase the working
  directory's `.claude/` links only `CLAUDE.md`, `skills` and `settings.json`.
  Agents, commands and memory are read by the runner itself, so they do not
  show up as ambient subagents or slash commands.

## Using this layer without Coro

Copy the layer into a repository to give Claude Code the same agents,
skills and workflows:

```bash
cp -R packages/intelligence-base/layer/.claude  /path/to/repo/.claude
cp    packages/intelligence-base/layer/AGENTS.md /path/to/repo/AGENTS.md
echo ".coro-work/" >> /path/to/repo/.gitignore
```

If the repository already has a `.claude/`, merge the folders instead of
replacing it, and append the layer's `CLAUDE.md` to yours.

Then, in Claude Code:

- `/agents` lists the subagents (`planner`, `coder`, `code-reviewer`,
  `evaluator`, the `review-*` lenses, …).
- Skills such as `golang-conventions` are picked up from `.claude/skills/`.
- Run a workflow as a slash command: `/coro:job <request>`,
  `/coro:job-fast <request>` or `/coro:job-deep <request>` (Claude Code
  namespaces commands by their folder). The command makes the main session
  the orchestrator: it delegates each phase to the
  named subagent, relays their questions to you, and stops at each
  checkpoint for approval. Specs, plans and reports go to
  `.coro-work/<run-slug>/`.
- Nothing calls `mcp__coro__*` tools. "Running without the Coro runner" in
  `.claude/CLAUDE.md` maps each runner tool to a normal one.

The workflows that need the runner (`campaign`, `pr-review`,
`retrospective`, `self-update`, `memory-curator`, `oss-contribution`) are
marked `disable-model-invocation: true`. They park jobs, post reviews and
open proposals, which a plain session cannot do. Start them from the Coro
dashboard or CLI.

### GitHub Copilot

Support is minimal on purpose. `AGENTS.md` at the repository root tells
Copilot's coding agent to read `.claude/CLAUDE.md` and the skills under
`.claude/skills/`. There are no `.github/agents` or prompt files, and the
workflow commands are not exposed in Copilot.

## Tests

`tests/manifest.test.ts` pins the layout and the invariants the runner and
Claude Code both rely on: agent front matter, read-only lenses, balanced
standalone fences, runner-only commands flagged, and no stale pre-native
paths.
