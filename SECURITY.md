# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| `main`  | Yes       |

We do not maintain separate release branches yet; security fixes land on `main`.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use [GitHub private vulnerability reporting](https://github.com/Coro-ai-framework/coro-developer-framework/security/advisories/new)
if enabled on the repository, or email the maintainer via the contact listed on the
GitHub org profile.

Include:

- Description of the issue and impact
- Steps to reproduce
- Affected versions / commits
- Proof-of-concept if available

## Response expectations

| Stage | Target |
|-------|--------|
| Initial acknowledgment | 2 business days |
| Severity assessment | 5 business days |
| Fix or mitigation plan | Depends on severity; critical issues prioritized |

We will coordinate disclosure timing with reporters and credit them if desired.

## Scope

In scope:

- Coro Runner (CLI, job engine, MCP tools, webhook handlers)
- Coro Dashboard and local/hybrid configuration surfaces
- Coro Cloud control plane (`packages/runner/src/cloud/`) when deployed

Out of scope:

- Vulnerabilities in third-party services (Anthropic, GitHub, Bitbucket, Jira, etc.)
- Issues in target repositories Coro clones during jobs (report to those projects)

## Safe harbor

We support good-faith security research. Do not access data you do not own, disrupt
production systems, or exfiltrate customer data.

## Dependency updates

Public repositories should keep Dependabot and secret scanning enabled. Report
supply-chain concerns the same way as product vulnerabilities.
