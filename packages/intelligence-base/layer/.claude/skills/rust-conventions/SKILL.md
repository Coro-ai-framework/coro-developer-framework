---
name: rust-conventions
description: >-
  Rust coding standards for Coro-managed services and crates: project layout,
  edition + toolchain posture, dependency choices, naming, error handling
  (anyhow vs thiserror), async (tokio), testing, logging. Use when writing or
  reviewing Rust code. Tenants override sections to encode local preferences.
---

# Rust Conventions

> **Note to tenants:** This is a generic baseline. Override with your team's
> preferences in your tenant overlay. Agents read this file strictly.

## Project layout

```
{crate-name}/
├── src/
│   ├── lib.rs               ← library crates only
│   ├── main.rs              ← binary crates only
│   ├── <module>/
│   │   ├── mod.rs
│   │   └── *.rs
│   └── bin/                 ← additional binaries (optional)
├── tests/                   ← integration tests (one .rs per test binary)
├── benches/                 ← criterion benchmarks
├── Cargo.toml
├── Cargo.lock               ← committed for binaries; for libraries follow workspace policy
└── README.md
```

Workspace crates live under `crates/<name>/` with the same internal layout.

## Toolchain

- Edition `2021` minimum (`2024` once stable in your toolchain).
- `rust-toolchain.toml` pins the toolchain channel + components
  (`rustfmt`, `clippy`).
- `cargo fmt` and `cargo clippy --all-targets --all-features -- -D warnings`
  are part of the build; PRs that fail clippy are blocking.

## Dependencies (defaults — tenants enhance)

| Purpose | Suggested crate |
|---|---|
| Async runtime | `tokio` (full features) |
| HTTP server | `axum` |
| HTTP client | `reqwest` |
| Serialisation | `serde` + `serde_json` |
| Errors (libraries) | `thiserror` |
| Errors (binaries) | `anyhow` |
| Logging / tracing | `tracing` + `tracing-subscriber` |
| Database | `sqlx` (compile-time-checked queries) |

## Naming

- Modules / files: `snake_case`.
- Types, traits, enums: `PascalCase`.
- Functions, methods, variables: `snake_case`.
- Constants and statics: `SCREAMING_SNAKE_CASE`.
- Lifetime parameters: short and meaningful (`'a`, `'src`, `'req`).

## Error handling

- **Libraries**: define error enums with `thiserror`. Each variant is a
  named, documented failure mode. Do not return `Box<dyn Error>` from
  library APIs.
- **Binaries**: use `anyhow::Result` at the top level. Add context with
  `.context("…")` at every boundary.
- `?` for propagation; never `.unwrap()` / `.expect()` outside tests and
  truly-infallible cases (and document those in a comment).

## Async

- `tokio` is the runtime. No mixing with `async-std`.
- Never block the runtime: file I/O goes through `tokio::fs`, CPU-bound
  work through `tokio::task::spawn_blocking`.
- Avoid `Mutex<T>` from std inside async — use `tokio::sync::Mutex` or
  rethink the data flow.

## Unsafe

- `unsafe` requires a safety comment immediately above explaining the
  invariants that make it sound.
- New `unsafe` blocks are blocking review findings unless the safety
  comment passes scrutiny.

## Testing

- Unit tests in `mod tests { … }` at the bottom of the file under test.
- Integration tests under `tests/` — one `.rs` file per test binary.
- Use `proptest` or `quickcheck` for property tests on data transformations.
- Snapshot tests via `insta`.

## Logging / tracing

- `tracing::instrument` on every public async function with non-trivial
  work. Span fields capture request / job / correlation IDs.
- No `println!` / `eprintln!` in production code.

## Anti-patterns to reject in review

- `clone()` on hot paths without a justification comment.
- `Vec<Box<dyn Trait>>` where a generic + monomorphisation would do.
- Holding a `MutexGuard` across `.await` — the borrow-checker will not
  always catch it; review must.
