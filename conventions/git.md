# Git and PR Conventions

Agents must follow these conventions for all git operations in migration and feature workflows.

## Branch naming

```
feature/{service-name}-{short-description}
fix/{service-name}-{short-description}
```

Examples:
- `feature/user-service-go-infrastructure`
- `feature/user-service-go-users-endpoints`
- `fix/user-service-go-token-validation`

Rules:
- All lowercase, hyphens only (no underscores, no slashes beyond the prefix)
- `{service-name}` is the Go service name (e.g., `user-service-go`)
- `{short-description}` is 2-5 words describing the work

## Commit messages

Format: `{type}: {description}`

Types:
- `feat:` — New functionality
- `fix:` — Bug fix or correction to match contract
- `refactor:` — Code restructure with no behavior change
- `test:` — Test additions or changes
- `chore:` — Build, config, dependency changes

Rules:
- Lowercase, present tense: `feat: add user registration endpoint` not `Added user registration`
- Max 72 characters for the subject line
- If the commit is in response to PR feedback: `fix: address PR feedback - {brief description}`

## PR title

`[{ServiceName}] {Feature description}`

Example: `[UserService] Migrate /users endpoints`

## PR description template

```markdown
## What
{1-2 sentences describing what this PR implements}

## Migration context
- Feature: {feature name from migration plan}
- Endpoints implemented:
  - METHOD /path/one
  - METHOD /path/two

## Deviations from .NET contract
{List any deviations, or "None"}

## Testing
{Describe how to test, or reference the acceptance criteria from the migration plan}

## Gaps / follow-up
{Any endpoints not yet implemented, with reason, or "None"}

[PR-REVIEWER-AGENT]
```

## PR review process

1. Coder opens PR and tags human reviewers + includes `[PR-REVIEWER-AGENT]`
2. PR Reviewer agent performs initial automated review
3. Human reviewers comment, approve, or request changes
4. Coder responds to all change requests
5. PR Reviewer agent verifies resolution and confirms via comment
6. At least one human approval required before merge
7. PR Reviewer agent triggers merge after human approval

## Merge strategy

- Squash merge to keep main branch history clean
- Squash commit message: same as PR title

## Branch lifecycle

- Branches are deleted after merge
- Never commit directly to `main`
- `main` always represents the latest merged, tested state
