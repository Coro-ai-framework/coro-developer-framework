# @coro-ai/cloud-protocol

Wire protocol shared between the [Coro runner](../runner) and the Coro
cloud control plane (the private `coro-cloud` server repo).

This package contains, and only contains:

- **Wire-shape TypeScript types** — interfaces describing every object that
  crosses the runner ⇄ cloud boundary (`Job`, `Proposal`, `JobInput`,
  `ExternalRef`, …).
- **Status vocabulary** — string-literal unions and enums that both sides
  must agree on (`JobType`, `STATUS_*`, `ProposalStatus`, …).
- **WebSocket message envelopes** — the runner ⇄ cloud control channel.
- **REST contract schemas** — Zod schemas + matching TS types for the
  `/api/v1/*` endpoints the dashboard talks to.
- **Protocol constants** — `PROTOCOL_VERSION`, heartbeat/RPC timing
  defaults.

It does **not** contain runtime helpers, network code, persistence, or
side effects. Those belong in the consumer packages.

## Versioning

Semantic versioning is the contract:

- **Major bump** — incompatible change to any wire shape, removal of a
  message type, or change to `PROTOCOL_VERSION`'s major component.
  Runner and cloud must be deployed in lockstep across a major bump.
- **Minor bump** — additive change (new optional field, new message
  type). Older peers ignore unknown fields/messages.
- **Patch bump** — documentation, internal refactors, no behaviour
  change.

## Status

Scaffold only. Population starts at Phase A.2 — see the project plan for
the move sequence.
