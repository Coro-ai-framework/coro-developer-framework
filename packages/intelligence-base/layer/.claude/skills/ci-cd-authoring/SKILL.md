---
name: ci-cd-authoring
description: >-
  Continuous-integration and continuous-deployment pipeline authoring
  checklist. Invoked by the code-reviewer L4 lens whenever the diff
  changes a CI / CD config (.github/workflows/*, .gitlab-ci.yml,
  Jenkinsfile, .circleci/*, buildkite, etc).
---

# CI / CD Authoring

This skill is a **checklist for changes to CI / CD pipelines**. Pipeline
files are infrastructure-as-code; a careless change can mask test
failures, leak secrets, or inflate build times by an order of magnitude.

It is provider-agnostic. The principles apply to GitHub Actions, GitLab
CI, Jenkins, CircleCI, Buildkite, Azure DevOps, and the rest.

## 1. Correctness

- **Failure must fail the build**. Steps that run scripts must check
  the script's exit code; pipes that lose the exit code (e.g.
  `cmd | tee log`) need `set -o pipefail` (or the equivalent).
- **No `|| true` to make things go green** unless explicitly justified
  in a comment. "Skipping flaky test" is not a justification — fix the
  flake.
- **No skipped jobs that pretend to run**. A conditional that always
  evaluates false because of a typo (`if: ${{ github.event.name == 'pulll_request' }}`)
  is silent failure waiting to happen.
- **The default branch's pipeline is the source of truth**. If a check
  only runs on PRs but not on the default branch, it cannot block
  regressions after merge.

## 2. Reproducibility

- **Pin everything**. Action versions, runner images, tool versions,
  language versions. `actions/checkout@v4` is acceptable; `@main` is
  not.
- **No live network in build steps** beyond explicitly chosen
  registries. Curl-piping to bash from a third-party domain is a
  supply-chain vulnerability.
- **Cache keys include the lockfile hash**. A cache hit on a stale
  lockfile produces undefined behaviour.

## 3. Secrets

- Secrets are read from the provider's secret store, not from the diff.
- New secrets are documented (name, owner, rotation cadence) — even if
  the documentation lives in a private wiki, link it.
- No secret values are echoed to logs (mask them; the provider usually
  has a primitive for this).
- Forked-PR builds do NOT receive secrets unless explicitly approved
  per the project's policy.

## 4. Permissions

- Use the principle of least privilege for the pipeline's identity:
  scope the token to the minimum needed permissions, scope the runner
  to the minimum needed contexts.
- A pipeline that needs `write` permissions should justify each
  permission in a comment.

## 5. Performance

- Cache dependencies (language package manager, build artefacts) where
  the provider supports it.
- Parallelise independent jobs; do not serialise just because the
  default template did.
- Skip large jobs on documentation-only PRs (`paths-ignore` or the
  equivalent).
- A pipeline whose median run exceeds ~10 minutes deserves a budget
  review.

## 6. Deployment hygiene (CD)

- Deploys gated by the same checks as merges (build, test, lint, type,
  security scan).
- Deployment configuration is versioned alongside the code; no
  click-ops in production.
- Rollback is one click / one command. If rollback requires a manual
  re-deploy of the previous tag, that is a gap worth flagging.
- Production deploys require human approval **or** the project has an
  explicit auto-deploy policy with documented monitoring + automatic
  rollback signals.

## 7. Observability of the pipeline

- Build / test failures are visible in the project's notification
  surface (Slack, email, dashboard) — not buried in the provider UI.
- Long-running jobs publish progress so an operator can tell "stuck"
  from "still working".

## Output integration

When invoked by the code-reviewer L4 lens, surface the highest-impact
finding (or "ok") in the `cross-cutting` section's
`dependency-hygiene` peer (or `security` if the finding is about
secrets / permissions). CI / CD findings are usually **blocking**
because pipeline regressions are easy to miss.
