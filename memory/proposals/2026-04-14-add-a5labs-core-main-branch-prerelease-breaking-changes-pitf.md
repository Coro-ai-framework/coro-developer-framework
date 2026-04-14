# Proposal: Add A5Labs.Core main-branch prerelease breaking changes pitfall

**Type:** memory-update
**Proposed by job:** a5labs.buyinbuyout-feature-1776153461092 (feature, phase: evaluation)
**Date:** 2026-04-14T08:22:08.213Z
**Files:** 1

## Rationale

During the BuyInBuyOut build fix job, we discovered that A5Labs.Core main-branch prerelease versions (1.0.0-main0XXX) have breaking API changes compared to CI builds (1.0.0-ci0XXX). Specifically, main0241 removed A5Labs.Core.Cache and ErrorCodes.PAYMENTS_FAILED_TO_RETRIEVE_ORDER, while ci0274 still has both. This is a distinct pitfall from the NuGet version fallback issue already documented — agents need to know that main-branch and CI-branch prereleases are NOT API-compatible.

## Description

Adds a new entry to memory/known-pitfalls.md documenting that A5Labs.Core main-branch prereleases (main0XXX) may have breaking API changes vs CI builds (ci0XXX), and agents should always prefer ci0XXX versions.

## Files

### `memory/known-pitfalls.md`

```md
# Known Pitfalls

Patterns that have caused failures in past migrations and feature jobs. Read before writing any code.

---

## NuGet: A5Labs.Core.* version fallback causes silent API mismatch

**Discovered:** 2026-04-14 | **Job:** a5labs.exchangerates-feature | **Severity:** high

When upgrading A5Labs.Core.* packages, always verify the target version exists in the Nexus feed (https://nexus.a5-labs-cloud.com/repository/dev.artifactory-nuget.afr/) before referencing it. NuGet will silently fall back to an older version via NU1603 warnings, which can cause namespace/API mismatches that break the build.

**What happened:** A coder agent referenced `1.0.0-ci0275` which does not exist. The latest 1.0.x CI build is `1.0.0-ci0274`. NuGet resolved to `1.0.0-main0239` (a release branch build), which lacked the `A5Labs.Core.Build` namespace added in `ci0274`. The build failed with `CS0234: The type or namespace name 'Build' does not exist in the namespace 'A5Labs.Core'`.

**Key details:**
- Not all A5Labs.Core.* packages have the same CI versions. For example, `A5Labs.Core.OpenTelemetry` only has up to `ci0273`, while `A5Labs.Core` itself has `ci0274`.
- NuGet pre-release version ordering: `ci` < `main` alphabetically, so `main0239 > ci0274` in NuGet's view.
- `ci0274` introduced `Microsoft.Extensions.Hosting.Abstractions 6.0.1` as a new dependency, which requires `Configuration.Abstractions >= 6.0.1`. Downstream projects pinning `6.0.0` will get NU1605 (package downgrade error).

**Prevention:** Query the Nexus API to verify version existence before upgrading:
```bash
curl -s -u "user:pass" "https://nexus.a5-labs-cloud.com/repository/dev.artifactory-nuget.afr/FindPackagesById()?id='A5Labs.Core'&\$filter=Version%20ge%20'1.0.0-ci0270'" | grep -o "Version='[^']*'" | sort -V -u
```

---

## NuGet: A5Labs.Core main-branch prereleases (main0XXX) have breaking API changes vs CI builds (ci0XXX)

**Discovered:** 2026-04-14 | **Job:** a5labs.buyinbuyout-feature | **Severity:** high

A5Labs.Core packages have two prerelease version streams: `1.0.0-ci0XXX` (CI pipeline builds) and `1.0.0-main0XXX` (main branch builds). The main-branch versions may contain breaking API changes that CI builds do not have. Always prefer `ci0XXX` versions unless explicitly targeting a main-branch feature.

**What happened:** Commit `57a0fdd` on `a5labs.buyinbuyout` upgraded all A5Labs.Core.* packages from `1.0.0-ci0268` to `1.0.0-main0241`. The `main0241` version had these breaking changes vs `ci0274`:
- `A5Labs.Core.Cache` package was removed entirely
- `ErrorCodes.PAYMENTS_FAILED_TO_RETRIEVE_ORDER` constant was removed
- The commit message claimed to fix the ErrorCodes reference but the change was never actually applied, leaving the build broken with 2 CS0117 errors

**Key details:**
- CI builds (`ci0XXX`) maintain backward compatibility within the same major version
- Main-branch builds (`main0XXX`) may remove APIs, rename constants, or drop entire sub-packages
- NuGet sorts `main` > `ci` alphabetically, so `1.0.0-main0239 > 1.0.0-ci0274` in semver — this can cause unexpected NU1605 downgrade errors when mixing versions
- Not all sub-packages are published at every CI build number (e.g., `Core.OpenTelemetry` has `ci0273` but not `ci0274`). When upgrading, check each sub-package individually.

**Prevention:**
1. Always prefer `ci0XXX` versions over `main0XXX` for A5Labs.Core packages
2. Before upgrading, query the Nexus feed for ALL sub-packages used to find the highest common CI version
3. If a sub-package doesn't have the target CI version, pin it to the highest available CI version (e.g., `ci0273` instead of `ci0274`)

```

---
_This proposal was generated automatically by an agent. Review and merge to apply._