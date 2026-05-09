---
name: typescript-conventions
description: >-
  TypeScript/Node.js coding standards for Coro-managed services and packages:
  project layout, tsconfig posture, dependency choices, naming, error handling,
  async/await discipline, testing, logging. Use when writing or reviewing TS/JS
  code. Tenants override sections to encode local preferences.
---

# TypeScript Conventions

> **Note to tenants:** This is a generic baseline. Override with your team's
> preferences in your tenant overlay. Agents read this file strictly — every
> rule here is enforced by the code-reviewer's L1 lens.

## Project layout

```
{package-name}/
├── src/
│   ├── index.ts             ← public exports only; no logic
│   ├── <feature>/           ← one directory per feature / bounded context
│   │   ├── *.ts
│   │   └── *.test.ts
│   └── lib/                 ← cross-feature utilities
├── tests/                   ← integration / e2e tests (if separated from unit)
├── package.json
├── tsconfig.json
└── README.md
```

Monorepo packages live under `packages/<name>/` with the same internal
layout.

## tsconfig posture

- `strict: true` always. `noImplicitAny`, `strictNullChecks`, `noImplicitOverride`, `noFallthroughCasesInSwitch` all on.
- `target` matches the project's deployed Node version; do not down-level transpile unless shipping to a browser.
- `module: nodenext` for libraries, `module: esnext` + a bundler for apps.
- `noUncheckedIndexedAccess: true` for new packages — accept the verbosity tax.

## Dependencies (defaults — tenants enhance)

| Purpose | Suggested package |
|---|---|
| HTTP server | `express` or `fastify` |
| Schema validation | `zod` |
| Logging | `pino` |
| Testing | `vitest` (preferred) or `jest` |
| Date/time | the platform `Intl` + `Temporal` polyfill (avoid `moment`) |

## Naming

- Files: `kebab-case.ts`. Test file alongside source: `foo.test.ts`.
- Types and classes: `PascalCase`.
- Functions, variables, methods: `camelCase`.
- Constants: `SCREAMING_SNAKE_CASE` only for module-level true constants.
- Avoid Hungarian / type-suffixed names (`UserI`, `UserType`); a `User`
  interface and a `User` value live in different namespaces.

## Error handling

- Throw `Error` subclasses with informative messages and `cause` chains
  (`throw new ConflictError("…", { cause: err })`).
- Never throw strings or plain objects.
- `try/catch` at boundaries (HTTP handlers, message consumers, CLI entry
  points). Don't sprinkle it through internal code to "be safe."
- Result-type / either patterns are acceptable when domain logic has
  expected non-exceptional failure modes; pick one library and stick with it
  per package.

## Async/await discipline

- `async/await` everywhere. No `.then(...)` chains in new code.
- Always `await` or explicitly fire-and-forget with `void`. An un-awaited
  promise that throws crashes the process under `--unhandled-rejections=strict`.
- Use `Promise.all` for independent work; never serialise unrelated awaits in
  a loop.

## Testing

- One `*.test.ts` per source file, alongside it.
- `describe` blocks group by subject; test names are full sentences:
  `it("returns 400 when email is missing", …)`.
- Prefer real implementations + in-memory adapters over mocks. Mock at the
  network / filesystem boundary only.
- Snapshot tests only for stable, structural outputs — never for prose.

## Logging

- `pino` with structured fields. No `console.log` / `console.error` in
  production code (test files are fine).
- Request loggers are child loggers with `requestId`, `userId`, `route`.
- Error logs include the full error object, not just the message.

## Module hygiene

- No barrel-of-everything `index.ts` re-exports across an internal feature
  boundary; only the package's top-level `src/index.ts` re-exports.
- No circular imports. If `tsc --noEmit` flags one, fix it immediately.
- Side effects on import are banned outside `cmd/` / `bin/` entry points.
