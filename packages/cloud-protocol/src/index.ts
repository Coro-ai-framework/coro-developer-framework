// @coro/cloud-protocol — wire protocol shared between the Coro runner and
// the Coro cloud control plane.
//
// This package is intentionally side-effect-free and runtime-light: pure
// TypeScript shape types, string-literal unions / enums that appear on the
// wire, Zod schemas for boundary validation, and protocol-version
// constants. Runtime helpers (functions that operate on these shapes)
// belong in the consumer packages (`@coro/runner`, `coro-cloud`), not
// here — that keeps the contract trivially auditable and prevents
// downstream drift.
//
// Population order across Phase A:
//   A.2  ExternalRef + NormalizedEvent types         ← done
//   A.3  Job-shape types + status vocabulary
//   A.4  InboundEvent / OutboundEvent
//   A.5  WebSocket message envelopes
//   A.6  PROTOCOL_VERSION constant
//   A.7  REST endpoint Zod schemas

export * from './refs'
