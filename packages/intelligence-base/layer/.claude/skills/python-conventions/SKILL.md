---
name: python-conventions
description: >-
  Python coding standards for Coro-managed services and packages: project
  layout, packaging (pyproject.toml), typing posture, dependency choices,
  naming, error handling, async, testing, logging. Use when writing or
  reviewing Python code. Tenants override sections to encode local
  preferences.
---

# Python Conventions

> **Note to tenants:** This is a generic baseline. Override with your team's
> preferences in your tenant overlay. Agents read this file strictly.

## Project layout (src layout)

```
{package-name}/
├── src/
│   └── {package_name}/
│       ├── __init__.py
│       ├── <feature>/
│       │   ├── __init__.py
│       │   └── *.py
│       └── lib/
├── tests/
│   └── test_*.py
├── pyproject.toml
└── README.md
```

`src/` layout is mandatory for new packages — it prevents accidental imports
of the working tree instead of the installed package.

## Packaging

- `pyproject.toml` only. No `setup.py`, no `requirements.txt` for libraries.
- Pin Python version explicitly in `requires-python`.
- Use `uv` or `poetry` consistently within a package.

## Typing posture

- All new code is fully typed. `mypy --strict` (or `pyright` in strict mode)
  must pass.
- Use `from __future__ import annotations` at the top of every module so
  forward refs work without quoting.
- `from typing import …` for stdlib generics on Python <3.12; native
  generics (`list[int]`, `dict[str, int]`) on 3.12+.
- Public APIs use protocols, not `ABC` subclasses, when duck typing is the
  intent.

## Dependencies (defaults — tenants enhance)

| Purpose | Suggested package |
|---|---|
| HTTP server | `fastapi` (preferred) or `starlette` |
| Schema validation | `pydantic` v2 |
| ORM | `sqlalchemy` 2.x with the typed API |
| Logging | stdlib `logging` with `structlog` for structured fields |
| Testing | `pytest` |
| Linting / formatting | `ruff` (lint + format) |

## Naming

- Modules and packages: `snake_case`.
- Classes: `PascalCase`.
- Functions, variables, methods: `snake_case`.
- Constants: `SCREAMING_SNAKE_CASE` at module level only.
- Private helpers: leading underscore. Name-mangled `__foo` is reserved for
  inheritance hazards — almost never the right tool.

## Error handling

- Define an exception hierarchy per package; do not raise bare `Exception`.
- Catch the narrowest type that meets the need. `except Exception:` is a
  smell — justify it in a comment when used.
- Use `raise … from err` to preserve the cause chain.

## Async

- One async style per package — either fully `async def` (FastAPI style) or
  fully sync. Mixing the two attracts subtle bugs.
- Never call sync I/O from an async function without explicit
  `asyncio.to_thread` / `loop.run_in_executor`.

## Testing

- `pytest` with `pytest-asyncio` when the package is async.
- Tests under `tests/`, file naming `test_<module>.py`, function naming
  `test_<behaviour>_when_<condition>`.
- Fixtures in `conftest.py` close to where they're used.
- Use `pytest.mark.parametrize` for table-driven tests.

## Logging

- Structured logs. `structlog.get_logger(__name__)` at module top.
- No `print()` in production code.
- Include `request_id`, `user_id`, and any business identifiers in every
  request-scoped log.

## Anti-patterns to reject in review

- Mutable default arguments (`def f(x=[]):`).
- `from foo import *` (allowed only in test fixtures).
- Catching `Exception` in async generators / context managers — they
  swallow `CancelledError` and break supervisor patterns.
- `time.sleep` inside async code paths.
