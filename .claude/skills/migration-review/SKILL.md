---
name: migration-review
description: >-
  Migration PR review checklist: contract compliance, route/method/shape
  verification, auth checks, convention verification, plan cross-reference.
  Use when reviewing migration PRs.
---

# Migration PR Review Guide

Domain-specific guidance for reviewing migration PRs. Supplements the generic PR Reviewer agent instructions with migration-specific contract checking and compliance verification.

## Contract compliance checklist

When reviewing a migration PR, verify against `service-contract.json`:

### Routes and methods
- [ ] Every endpoint in the feature is implemented with the correct route
- [ ] HTTP methods match exactly (GET, POST, PUT, PATCH, DELETE)
- [ ] Route parameters have correct types and constraints
- [ ] Query parameters are parsed with correct names, types, and defaults

### Request/response shapes
- [ ] JSON field names match the source contract exactly (case-sensitive)
- [ ] All fields from the contract are present — no silent omissions
- [ ] Nullable fields use pointer/optional types
- [ ] DateTime/TimeSpan serialization matches the source format
- [ ] Enum serialization matches (string vs integer)

### Status codes
- [ ] All documented status codes are returned in correct conditions
- [ ] Validation errors return the same error shape as the source service
- [ ] Error responses use the correct format (e.g., `ProblemDetails`)

### Auth
- [ ] Auth requirements from the contract are implemented
- [ ] Correct claims are validated
- [ ] Auth error responses match the source service

### Tests
- [ ] Tests exist for all handlers in the feature
- [ ] Tests cover happy path, validation errors, auth failures, not found
- [ ] Tests compile and pass

## Convention verification

Verify the code follows the language conventions. Invoke the relevant language conventions skill if you haven't already. Common checks:
- Project/module layout follows conventions
- Naming follows language idioms
- Error handling follows conventions
- Logging follows conventions

## Migration plan cross-reference

- Verify the PR implements exactly the endpoints listed for this feature in the migration plan
- Check that dependency ordering is respected (don't merge Feature 3 before Feature 2 if there's a dependency)
- Verify branch naming follows the git conventions

## Common migration review issues

- Hardcoded values that should come from config/env vars
- Missing global error handler registration
- Auth middleware not applied to endpoints that require it
- JSON serialization annotations missing or incorrect
- Validation logic that doesn't match source behavior
- Missing Content-Type headers on responses

## Feedback patterns to watch for

After each PR review cycle, check if any feedback patterns are emerging:
- Same type of issue across multiple features/PRs
- Gaps in the coder's instructions that lead to recurring mistakes
- Convention violations that should be caught earlier

Document these in `memory/pr-feedback.md` so the system can learn and prevent them in future jobs.
