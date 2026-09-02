# Activity adapters

An adapter maps one event source onto the source-agnostic `ActivityItem[]` model
in `components/activity/types.ts`.

Responsibilities:

- Translate the source's wire format into `ActivityEntry` / `message` / `notice` / `card` items.
- Supply `runningLabel` / `settledLabel` (the feed never invents copy).
- Call `appendEntry` / `settleEntry` so consecutive same-group entries stack.

Two rules keep the activity layer reusable:

1. Nothing in `components/activity/**` may import from `components/plan/**`,
   `hooks/useIntakeStream.ts`, or `lib/intake-brief.ts`.
2. Card renderers are injected via `cardRenderers` — adapters may emit
   `{ kind: 'card', card: { type, data } }` but must not import a renderer.

## `intake.ts` (built)

Consumes `POST /intake/stream` SSE frames (`token` / `tool_start` / `tool_end` /
`done` / `error`). Only tool events mutate the item list; tokens and turn
lifecycle stay on the plan-session provider.

## `job-log.ts` (not built yet)

Would consume `LogLine` from `src/hooks/useJobStream.ts` and map
`classifyLine`'s `LogLineType` onto this model:

- `text` → `message` (`role: 'assistant'`)
- `human` → `message` (`role: 'user'`)
- `tool_use` → an `ActivityEntry` (`group: 'working'`) settled immediately by
  the following `tool_summary` line
- `thinking` → `ActivityEntry` with `group: 'thinking'`
- `error` / `warning` / `guardrail` → `notice`
- `phase` / `result` → cards registered in a `JOB_CARD_RENDERERS` map

The gap to close first is that job logs are **strings, not structured events**
— `tool_use` lines are matched with `/^→ (\S+)(.*)/` — so the adapter will be
lossier than the intake one until the runner emits structured events on that
stream. Do not treat that as a blocker for plan-mode-only New Run.
