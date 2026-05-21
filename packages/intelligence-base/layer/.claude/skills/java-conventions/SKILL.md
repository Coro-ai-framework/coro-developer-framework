---
name: java-conventions
description: >-
  Java coding standards for Coro-managed services and libraries: project
  layout (Gradle / Maven), JDK posture, dependency choices (Spring Boot,
  JUnit), naming, error handling, concurrency, testing, logging. Use when
  writing or reviewing Java code. Tenants override sections to encode local
  preferences.
---

# Java Conventions

## Coro job workspace

Run `mvn` / `gradle` and `git` from the repo checkout (`cd <repoCheckoutDir> && …`). See **golang-conventions** for Coro path layout; add Java-specific build recipes here per tenant.

> **Note to tenants:** This is a generic baseline. Override with your team's
> preferences in your tenant overlay. Agents read this file strictly.

## Project layout (Maven / Gradle standard)

```
{module-name}/
├── src/
│   ├── main/
│   │   ├── java/
│   │   │   └── com/{org}/{module}/
│   │   │       ├── <feature>/
│   │   │       └── lib/
│   │   └── resources/
│   └── test/
│       ├── java/
│       └── resources/
├── build.gradle(.kts) | pom.xml
└── README.md
```

Multi-module repos use `:module-name` (Gradle) or `<module>` (Maven) per
top-level subproject.

## JDK posture

- Target the latest LTS the platform supports (JDK 21 today).
- Records, sealed types, pattern matching for `switch`, and text blocks are
  encouraged — use the language features the LTS gives you.
- Compile with `-Werror -Xlint:all` (Maven equivalent).

## Dependencies (defaults — tenants enhance)

| Purpose | Suggested library |
|---|---|
| Application framework | `spring-boot` (web, data, security) |
| Build | Gradle Kotlin DSL or Maven |
| Validation | `jakarta.validation` (`hibernate-validator`) |
| Logging | SLF4J API + Logback |
| Testing | JUnit 5 + AssertJ + Mockito |
| HTTP client | the JDK `HttpClient` for new code; `WebClient` when reactive |

## Naming

- Packages: lowercase, dot-separated (`com.acme.payments.refund`).
- Classes, interfaces, records, enums: `PascalCase`.
- Methods, variables: `camelCase`.
- Constants: `SCREAMING_SNAKE_CASE` (`static final`).
- Test classes: `<ClassUnderTest>Test`. Test methods use full sentences:
  `returns400WhenEmailIsMissing`.

## Error handling

- Custom checked exceptions only when the caller is expected to recover; in
  most modern Java code, prefer unchecked.
- Define a domain exception hierarchy per module. Do not throw `RuntimeException`
  directly.
- Translate exceptions at boundaries: REST controllers map domain
  exceptions to ProblemDetails responses centrally (e.g. `@ControllerAdvice`).
- Never swallow exceptions. `catch (Exception ignored)` requires a comment
  explaining why.

## Null discipline

- `Optional<T>` for return types where absence is meaningful. Do **not** use
  it for fields or method parameters.
- Annotate intentionally-nullable parameters/returns with
  `@Nullable` (JSpecify or your project's nullability annotation set).
- New code passes static null analysis (NullAway / ErrorProne) clean.

## Concurrency

- Prefer immutability and `record` types over manual synchronisation.
- Use the `java.util.concurrent` primitives; do not call `Thread.sleep` in
  business logic.
- Virtual threads for blocking I/O servers on JDK 21+; don't mix them with
  reactive code in the same module.

## Testing

- JUnit 5 (`@Test`, `@ParameterizedTest`).
- AssertJ for assertions (`assertThat(actual).isEqualTo(expected)`); avoid
  `assertEquals` from JUnit.
- Mockito for mocks; prefer constructor injection so tests can pass real
  collaborators.
- Integration tests use Testcontainers for any external dependency.

## Logging

- SLF4J only. Never `System.out.println`.
- Parameterised messages: `log.info("user {} created", userId)` — never
  string concatenation.
- MDC carries request / correlation IDs; populate at the boundary, clear in
  a finally block.

## Anti-patterns to reject in review

- Field injection (`@Autowired` on a field). Constructor injection only.
- Returning `null` from a method whose return type is a collection.
- `static` mutable state.
- Catching `Throwable`.
