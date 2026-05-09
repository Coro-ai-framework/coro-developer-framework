---
name: kotlin-conventions
description: >-
  Kotlin coding standards for Coro-managed services and libraries: project
  layout (Gradle Kotlin DSL), JVM target, dependency choices, naming, error
  handling, coroutines, testing, logging. Use when writing or reviewing
  Kotlin code. Tenants override sections to encode local preferences.
---

# Kotlin Conventions

> **Note to tenants:** This is a generic baseline. Override with your team's
> preferences in your tenant overlay. Agents read this file strictly.

## Project layout

Same Maven / Gradle layout as Java. Kotlin sources go under
`src/main/kotlin` and tests under `src/test/kotlin`.

## Toolchain

- Gradle Kotlin DSL (`build.gradle.kts`).
- JVM target matches the JDK LTS the platform supports (21 today).
- `-Werror` and explicit API mode (`kotlin { explicitApi() }`) for library
  modules.
- ktlint or detekt enforced in CI.

## Dependencies (defaults — tenants enhance)

| Purpose | Suggested library |
|---|---|
| Application framework | `spring-boot` (Kotlin DSL) or `ktor` |
| Serialisation | `kotlinx.serialization` |
| Logging | `kotlin-logging` over SLF4J |
| Testing | JUnit 5 + Kotest assertions or AssertJ |
| HTTP client | `ktor-client` for coroutine-native code |
| Coroutines | `kotlinx.coroutines-core` |

## Naming

- Packages: lowercase, dot-separated.
- Classes, objects, interfaces, enums: `PascalCase`.
- Functions, properties: `camelCase`.
- Constants (`const val` or top-level `val` of primitives): `SCREAMING_SNAKE_CASE`.
- Backticked identifiers only in test names (`fun \`returns 400 when email is missing\`()`).

## Idiomatic style

- Prefer expression bodies and `when` over imperative branching.
- Use `data class` for value types; `value class` for typed wrappers around
  primitives.
- Use scope functions (`let`, `apply`, `also`, `run`, `with`) deliberately,
  not as a stylistic tic. The reader should be able to explain why each one
  was chosen.
- Default arguments and named parameters over telescoping constructors and
  builders.

## Null safety

- Lean on the type system: prefer non-nullable types and propagate
  nullability only where it is meaningful.
- `!!` is a code smell. Each occurrence is reviewable; justify it in a
  comment or refactor.
- `requireNotNull` / `checkNotNull` at boundaries communicate intent better
  than a bare `!!`.

## Error handling

- Throw exceptions for unexpected failures; use `Result<T>` or sealed
  result types for expected non-exceptional failure modes.
- Define a sealed exception hierarchy per module.
- Coroutine cancellation is **not** an error to swallow — let
  `CancellationException` propagate.

## Coroutines

- One coroutine library per module (`kotlinx.coroutines`); do not mix with
  reactive frameworks in the same code path.
- Use structured concurrency (`coroutineScope`, `supervisorScope`) — never
  fire-and-forget into `GlobalScope`.
- Inject a `CoroutineDispatcher` instead of hard-coding `Dispatchers.IO`;
  it makes tests deterministic.
- `suspend` functions never block; use `withContext(Dispatchers.IO)` for
  blocking work and document why.

## Testing

- JUnit 5 + (Kotest assertions OR AssertJ) — pick one assertion library per
  package.
- `runTest { … }` for coroutine tests; use `TestDispatcher` for time
  control.
- Backticked, sentence-style test names.

## Logging

- `kotlin-logging` (`private val log = KotlinLogging.logger {}`).
- Lazy log messages: `log.debug { "expensive: $value" }` so the string is
  built only when the level is enabled.
- Never `println`.

## Anti-patterns to reject in review

- `lateinit var` outside Spring-managed beans / DI roots.
- `companion object` used as a dumping ground for unrelated statics.
- `runBlocking` in production code (allowed only at executable entry
  points).
- `GlobalScope.launch`.
