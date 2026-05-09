---
name: ruby-conventions
description: >-
  Ruby coding standards for Coro-managed services and gems: project layout,
  Ruby version posture, dependency choices (Rails / Sinatra), naming, error
  handling, testing, logging. Use when writing or reviewing Ruby code.
  Tenants override sections to encode local preferences.
---

# Ruby Conventions

> **Note to tenants:** This is a generic baseline. Override with your team's
> preferences in your tenant overlay. Agents read this file strictly.

## Project layout

### Gem

```
{gem-name}/
├── lib/
│   ├── {gem_name}.rb         ← public API surface
│   └── {gem_name}/
│       └── *.rb
├── spec/                     ← RSpec tests
├── {gem_name}.gemspec
├── Gemfile
└── README.md
```

### Rails app

Standard Rails skeleton. Keep `app/services/` for service objects and
`app/serializers/` for response shaping; do not stuff business logic into
controllers or models.

## Toolchain

- Pin the Ruby version in `.ruby-version` and `Gemfile` (`ruby "3.x.y"`).
- Bundler for dependency management. `bundle config set frozen 'true'` in
  CI.
- RuboCop in CI; `rubocop -A` in pre-commit.
- Rails apps target the latest stable Rails minor.

## Dependencies (defaults — tenants enhance)

| Purpose | Suggested gem |
|---|---|
| Web framework | `rails` (full apps) or `sinatra` (lightweight) |
| Background jobs | `sidekiq` |
| Testing | `rspec-rails` (or `minitest` if the project standardised on it) |
| Mocking / stubs | `webmock`, `vcr` for HTTP; built-in RSpec mocks otherwise |
| Code style | `rubocop` + `rubocop-rails` + `rubocop-rspec` |

## Naming

- Files / directories: `snake_case`.
- Classes, modules: `PascalCase`.
- Methods, variables: `snake_case`.
- Constants: `SCREAMING_SNAKE_CASE`.
- Predicate methods end in `?`; bang methods (`!`) only when there is a
  non-bang counterpart and the bang variant is destructive.

## Idiomatic style

- Prefer `private def …` over `private` followed by a block of methods —
  the visibility marker stays local to the method.
- Use keyword arguments for any method with more than one optional
  parameter.
- `Struct.new` and `Data.define` (Ruby 3.2+) for value types.
- Avoid monkey-patching standard library / framework classes from
  application code; use refinements when you must.

## Error handling

- Raise specific exception subclasses; do not raise `StandardError` or
  `RuntimeError` directly.
- `rescue StandardError` (not bare `rescue`) — bare rescues swallow
  `Interrupt` and break test runners.
- Service objects return result objects (`Success`/`Failure`) for expected
  failure modes; reserve exceptions for unexpected ones.

## Testing

- RSpec by default. One `*_spec.rb` per source file under a mirrored
  directory tree (`spec/services/foo_spec.rb` for `app/services/foo.rb`).
- `describe` for the subject, `context` for the precondition, `it` for the
  expected behaviour. Names are sentences:
  `it "returns 400 when email is missing"`.
- Use `let` over `before` for setup; avoid mutable shared state across
  examples.
- For Rails: prefer request specs over controller specs; system specs for
  end-to-end UI.

## Logging

- Structured logs via the project's logger (`Rails.logger` or a
  `Semantic::Logger` instance). Never `puts` in production code.
- Tag log entries with the request / job ID via the logger's tagged-logging
  facility.

## Anti-patterns to reject in review

- `eval` / `class_eval` in application code (frameworks may use it; you
  should not).
- Long parameter lists — push to keyword arguments + a small param object.
- `rescue Exception` (catches `Interrupt`, `SystemExit`, etc.).
- N+1 queries in ActiveRecord — use `.includes` / `.preload` / Bullet to
  detect them in dev.
- Service objects that take `params` directly from a controller; pass
  parsed primitives instead.
