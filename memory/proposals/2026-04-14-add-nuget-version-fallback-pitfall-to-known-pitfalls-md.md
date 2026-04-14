# Proposal: Add NuGet version fallback pitfall to known-pitfalls.md

**Type:** memory-update
**Proposed by job:** a5labs.exchangerates-feature-1776149193895 (feature, phase: evaluation)
**Date:** 2026-04-14T07:06:00.035Z
**Files:** 1

## Rationale

During the ExchangeRates build fix job, the coder agent in a prior run referenced A5Labs.Core.* version 1.0.0-ci0275 which doesn't exist in the Nexus NuGet feed. NuGet silently fell back to 1.0.0-main0239 via NU1603, which lacked the A5Labs.Core.Build namespace and broke the build. This is a subtle failure mode that should be documented so future agents always verify package versions exist before referencing them.

## Description

Adds a new entry to memory/known-pitfalls.md documenting the NuGet version fallback trap with A5Labs.Core.* packages on the Nexus feed.

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

```

---
_This proposal was generated automatically by an agent. Review and merge to apply._