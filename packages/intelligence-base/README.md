# @coro-ai/intelligence-base

The **base intelligence layer** that ships with every Coro install.

It contains the company-agnostic markdown that defines what every Coro
runner can do out of the box:

```
layer/
├── .claude/
│   ├── CLAUDE.md             ← Always-loaded runtime instructions (generic)
│   └── skills/               ← On-demand skills bundled with the platform
│       ├── feature-planning/
│       ├── feature-testing/
│       ├── golang-conventions/
│       ├── dotnet-conventions/
│       └── self-improvement-guide/
├── agents/                   ← Generic agent role definitions
├── workflows/                ← Generic workflow phase definitions
└── memory/                   ← Empty memory templates (tenants populate)
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
```

The runner uses this to find the base layer at job-prep time. A future
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

Conflict resolution: last-wins for `agents/`, `workflows/`, `skills/`;
concatenated for `.claude/CLAUDE.md` and `memory/`. The resolver
materialises the merged tree into a per-job `_intelligence/` directory
that the runner points the SDK at.
