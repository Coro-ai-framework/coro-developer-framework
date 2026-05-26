# Coverage Baseline — Phase 0 Lockdown

> Captured at the close of Phase 0 of the multi-provider LLM refactor.
> The Phase 0–9 verification gate enforces **no regression below these
> numbers**. Pushing them upward is explicitly NOT a Phase 0 deliverable —
> that is scope creep. Each subsequent phase is responsible for keeping
> its touched files at-or-above their baseline.

## How to reproduce

```bash
pnpm -F @coro-ai/runner test:coverage
```

Configuration: `packages/runner/vitest.config.ts` — provider `v8`,
includes `src/**/*.ts`, reporters `text` + `text-summary`.

## Aggregate baseline

| Metric     | Coverage           |
|-----------:|--------------------|
| Statements | 41.54% (2952/7105) |
| Branches   | 36.25% (1790/4937) |
| Functions  | 45.48% (529/1163)  |
| Lines      | 42.60% (2772/6506) |

## Hot-file baselines (the surfaces touched by Phases 1–9)

| File                            | Statements | Branches | Functions | Lines  |
|---------------------------------|-----------:|---------:|----------:|-------:|
| `src/jobs/runner.ts`            | 73.89%     | 66.66%   | 74.07%    | 76.02% |
| `src/jobs/dispatcher.ts`        | 63.18%     | 60.48%   | 57.40%    | 65.59% |
| `src/jobs/types.ts`             | 97.29%     | 100%     | 94.73%    | 97.29% |
| `src/jobs/creation.ts`          | 54.83%     | 48.57%   | 75.00%    | 64.15% |
| `src/jobs/cancel-preflight.ts`  | 86.20%     | 76.92%   | 80.00%    | 88.88% |
| `src/mcp-handlers.ts`           | 45.45%     | 29.44%   | 56.92%    | 46.15% |
| `src/mcp-server.ts`             | 37.50%     | 0.00%    | 33.33%    | 42.85% |
| `src/workflow-parser.ts`        | 97.14%     | 95.08%   | 100%      | 98.36% |
| `src/plugins/registry.ts`       | 86.66%     | 81.81%   | 90.90%    | 85.29% |
| `src/plugins/loader.ts`         | 90.43%     | 86.02%   | 92.85%    | 95.74% |
| `src/plugins/refs.ts`           | 86.95%     | 88.00%   | 100%      | 89.47% |
| `src/intelligence/resolver.ts`  | 77.77%     | 80.00%   | 100%      | 78.00% |
| `src/intelligence/writer.ts`    | 94.69%     | 88.31%   | 100%      | 96.00% |
| `src/prompt/builder.ts`         | 98.18%     | 93.93%   | 100%      | 98.11% |
| `src/state/sqlite-backend.ts`   | 80.46%     | 59.09%   | 91.17%    | 84.54% |
| `src/state/redis-backend.ts`    | 68.96%     | 55.88%   | 75.00%    | 71.31% |
| `src/tools/campaign.ts`         | 56.79%     | 42.53%   | 61.53%    | 54.79% |
| `src/tools/self-improvement.ts` | 80.95%     | 65.97%   | 84.37%    | 84.21% |

## Regression gate (per phase)

For every phase in the multi-provider plan:

1. Run `pnpm -F @coro-ai/runner test:coverage` after the phase's source changes.
2. For each file the phase modified, the four metrics (statements / branches /
   functions / lines) **must not drop below the baseline above** by more than
   the rounding-noise tolerance of **0.50 percentage points**.
3. New files added by a phase must land at **≥ 80 % statements / lines** for
   the file's logic to count as production-ready under the plan's bar
   ("no proof of concept or half baked code").

## Files intentionally at 0%

These are reported at 0% in the baseline because they are exercised only by
end-to-end paths the unit test suite does not cover today. They are out of
scope for the multi-provider refactor and do not need to be lifted by it:

- `src/cli/**` (CLI entry points)
- `src/runner/index.ts`, `src/runner/server.ts`, `src/runner/hybrid-dispatcher.ts`
- `src/cloud/index.ts`, `src/cloud/routes/**`
- `src/clients/**` (HTTP wrappers — covered by integration tests with live providers)
- `src/state/redis-backend.ts` write paths (covered only with a live Redis)
- All `*types.ts` files (interface declarations only)

## Why not raise the bar in Phase 0?

The plan is explicit: Phase 0 is a **lockdown**, not a coverage push. Lifting
`mcp-handlers.ts` from 45 % to 80 % would require an additional ~30 tests
covering tool wiring that is about to be refactored in Phases 4 and 9
(MCP file tools and `run_subagent`). Those tests would either become dead
code or need rewriting — both violate the "elegant, maintainable" bar.

The right moments to raise coverage on each file:

| File                      | Coverage push happens in |
|---------------------------|--------------------------|
| `src/jobs/runner.ts`      | Phase 2 (executor refactor) |
| `src/jobs/dispatcher.ts`  | Phase 8 (cloud / WS routing changes) |
| `src/mcp-handlers.ts`     | Phase 4 (MCP file tools) and Phase 9 (run_subagent) |
| `src/tools/campaign.ts`   | Already partially covered by new lockdown tests added in Phase 0.2 |
