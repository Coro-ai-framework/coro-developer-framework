---
name: architecture-review
description: Contract-break taxonomy and decision checklist for the architecture review lens.
---

# Architecture review

## Contract breaks

Removed or renamed fields and endpoints. Type or nullability changes. Reused protobuf field numbers. Removed enum values. Event or message schema changes. OpenAPI, GraphQL, AsyncAPI, or Avro diffs. Public SDK surface changes. Database schema changes another service reads.

A checker result in the packet is evidence. Confirm it and explain who it affects. Do not hunt for a break the checker already reported.

## Decisions

An ADR or tech-radar entry the change violates: a synchronous call where messaging was required, a new datastore, a library on hold, a bypassed gateway or auth layer. Quote the source. If you cannot point at one, it is a note, not a finding.

## Boundaries

Imports across a module or layer boundary. A service writing another service's data. A new dependency the catalog does not declare.

## Consumers

From the catalog, who depends on the changed contract. Live consumers make a break a blocker. No known consumers make it a major.
