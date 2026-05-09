---
name: db-migrations-safe
description: >-
  Database migration safety checklist — schema and data migrations
  applied to a live system without downtime. Invoked by the Analyzer
  (DEEP) and the code-reviewer L4 lens whenever a migration file is
  added or changed. Engine-agnostic.
---

# Safe Database Migrations

This skill is a **safety checklist for database migrations** applied to
a running system. It is engine-agnostic (Postgres, MySQL, SQL Server,
SQLite, MongoDB, DynamoDB), though some checks only apply to relational
engines and are noted as such.

## The two-phase rule

A migration that changes a contract used by running code must be
deployed in **at least two phases**, with the deploy in between:

1. Migration N introduces the new shape **alongside** the old.
2. Application deploy starts using the new shape (still tolerates the
   old).
3. Migration N+1 removes the old shape, after every running instance is
   on the new code.

Trying to do this in one migration + one deploy creates a window where
either the schema or the code is wrong for half of the running
instances. Avoid it.

## 1. Schema migrations (relational)

- **Adding a column**: must be nullable or have a server-side default.
  Adding `NOT NULL` without a default in one step locks the table on
  large engines.
- **Adding a NOT NULL column**: ship in two phases — phase 1 adds with
  default, phase 2 enforces NOT NULL after backfill.
- **Renaming a column or table**: never in one step. Phase 1 add the
  new name as an alias; phase 2 (later release) drop the old name.
- **Adding an index**: use the engine's concurrent / online variant
  (`CREATE INDEX CONCURRENTLY` on Postgres, `ALGORITHM=INPLACE` on
  MySQL). Hot tables should never lock for an index build.
- **Dropping a column**: only after the application has stopped reading
  and writing it for at least one full release.
- **Changing a type**: usually a two-phase add-new-column + backfill +
  drop-old-column dance. Engine-native type changes that rewrite the
  table are forbidden on hot tables.

## 2. Data migrations / backfills

- **Idempotent**: the backfill must produce the same end-state if run
  twice (often partially). Use `WHERE col IS NULL` / `ON CONFLICT DO
  NOTHING` patterns.
- **Batched**: never `UPDATE entire-table SET ...` on a hot table.
  Loop in batches with a delay.
- **Cancellable**: the backfill records its progress so it can resume
  after an interruption.
- **Observable**: emit a metric or log line per batch so an operator
  can watch progress.

## 3. Constraints and invariants

- New foreign keys: add the column nullable, backfill, then add the FK
  with `NOT VALID` (Postgres) and `VALIDATE CONSTRAINT` later. Engines
  without `NOT VALID` need a maintenance window or extreme caution.
- New unique constraints: same pattern — backfill, dedupe, then add.
  Adding a unique constraint on a column with duplicates fails the
  migration mid-run, leaving an inconsistent state.
- Check constraints: prefer `NOT VALID` + later validate; the validate
  step is read-only and won't lock writes.

## 4. Reversibility

- Every migration declares its rollback strategy. Two acceptable
  shapes: a true reverse migration, or "no rollback — re-deploy with
  feature flag off and run a forward fix".
- Migrations that drop or rewrite data should NOT have an automated
  reverse (data is lost). Document the manual recovery path.

## 5. Multi-tenant / sharded considerations

- Per-tenant migrations: declare ordering (apply on a single tenant
  first; soak; then fan out).
- Sharded migrations: declare the per-shard apply order and the
  cross-shard consistency window.
- Read replicas: account for replica lag during the deploy of the
  consumer code.

## 6. Document migrations

- A short README / comment alongside the migration explains:
  - what it changes
  - why
  - the deploy ordering (which deploy reads new shape, which deploy
    drops old shape)
  - rollback strategy
- The change is reflected in the contract test for the schema (see
  `feature-testing-contract`).

## Output integration

When invoked by the code-reviewer L4 lens, surface the highest-impact
finding (or "ok") in the `cross-cutting` section. Migration findings are
almost always **blocking** — schema mistakes are exceptionally hard to
unwind in production.
