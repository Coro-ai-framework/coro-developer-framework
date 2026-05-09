---
name: dependency-hygiene
description: >-
  Dependency hygiene checklist — added, removed, or upgraded third-party
  dependencies. Invoked by the code-reviewer L4 lens. Stack-agnostic.
---

# Dependency Hygiene

This skill is a **checklist for changes to a project's third-party
dependencies**: package-manager manifests (package.json, go.mod,
Cargo.toml, requirements.txt, pyproject.toml, pom.xml, build.gradle,
*.csproj, Gemfile, …), lockfiles, and native / OS-level deps
(Dockerfile, devcontainer, CI image).

## 1. Adding a dependency

For every newly added dependency, verify:

- **Justification**: a one-line reason in the PR description or in a
  `decisions[]` row of the job register. "Easier than writing it
  ourselves" is acceptable when the dep is small, well-maintained, and
  in scope.
- **Pinned version**: the manifest pins to a specific version (or
  range with the project's standard lower-bound). No `*`, `latest`,
  `master`, or unpinned ranges.
- **Lockfile updated**: the corresponding lockfile entry exists. Adds
  without lockfile updates produce non-reproducible builds.
- **Licence compatible**: the dep's licence is compatible with the
  project's. AGPL / GPL deps in a permissively-licensed project are a
  blocking issue.
- **Maintenance signal**: the dep has had a release in the last
  ~12-24 months (rule of thumb; use judgement). Abandoned deps are
  technical debt by default.
- **Transitive blast radius**: a dep that pulls in dozens of new
  transitive deps deserves extra scrutiny — flag in the review.
- **Security advisories**: the dep has no open critical advisories.
  Run the project's audit command (`npm audit`, `pip-audit`,
  `cargo audit`, `govulncheck`, `dotnet list package --vulnerable`,
  …) and surface anything new.

## 2. Removing a dependency

- **Nothing left importing it**. Grep the codebase for the dep name;
  any remaining import is a build-break waiting to happen.
- **Lockfile pruned**: the lockfile no longer references the dep.
- **Native / OS deps**: if the dep had a native side (binary, system
  package, Dockerfile install), that side is also removed.

## 3. Upgrading a dependency

- **Patch upgrade** (1.2.3 → 1.2.4): usually safe; no extra checks
  beyond CI.
- **Minor upgrade** (1.2.x → 1.3.x): read the changelog for new
  features the project might want to start using; verify no
  deprecation warnings in the build output.
- **Major upgrade** (1.x → 2.x): a major upgrade is a feature; treat
  it as one. Read the migration guide; check every breaking change
  against the project's usage; update the project's call sites in the
  same PR.
- **Lockfile-only upgrades**: an upgrade that touches only the
  lockfile (not the manifest) is usually a transitive bump. Confirm
  it isn't pulling in something unexpected.

## 4. Native / OS-level dependencies

- New native bindings or system packages are recorded in **all** the
  project's manifests: Dockerfile, devcontainer, CI image, local
  setup script, README setup section.
- Architecture-specific assumptions (`linux/amd64` only) are
  documented or explicitly handled (multi-arch images, CI matrix).

## 5. Security signals

- Run the project's audit command on every dep change. Surface any
  new vulnerable advisories — even transitive — in the PR review.
- Check if a removed dep was holding back a known-vulnerable
  transitive dep; the upgrade may have unblocked a fix.
- Pin to a version that has the vulnerability fix, or document why
  the project is not yet upgradable (workaround, deferred).

## 6. Build / test impact

- A dep change that doesn't change build output, test output, or
  lockfile is a no-op — challenge whether the PR is needed.
- A dep upgrade that breaks a test in an unexpected place is a
  signal: the test was relying on undocumented behaviour and needs
  a real assertion.

## Output integration

When invoked by the code-reviewer L4 lens, surface the highest-impact
finding (or "ok") in the `cross-cutting` section's `dependency-hygiene`
peer. Findings about new vulnerable advisories or unpinned versions are
**blocking**.
