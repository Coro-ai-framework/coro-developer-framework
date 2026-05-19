# Non-goals

Coro is intentionally narrow. These are things we are **not** trying to do (at least for now).

## General-purpose agent framework

Coro is a **software-engineering workflow runner** (plan → code → review → evaluate → PR), not a platform for arbitrary agents, chatbots, or RPA. Use overlays and plugins to extend within that domain.

## Replacing your IDE or Claude Code

Coro orchestrates jobs and intelligence layers; it does not aim to be a full IDE replacement. Claude Code (and similar tools) remain the coding surface; Coro coordinates multi-phase workflows across repos.

## Multi-provider parity on day one

We welcome additional LLM executor plugins, but we will not accept architectural changes that cripple the Claude Agent SDK integration path. OpenAI support exists to prove extensibility, not to guarantee feature parity with every provider.

## Hosted Coro for third parties (without a license)

Running Coro inside your company is in scope under BUSL. Operating a competing multi-tenant **Coro-as-a-Service** for external customers is a commercial offering — see [NOTICE.md](NOTICE.md).

## On-prem / air-gapped Cloud

Enterprise on-prem control plane deployments are deferred until there is concrete demand and a support model.

## Marketplace for community plugins

Deferred until there is a critical mass of third-party plugins and maintainers to support curation.

## Mobile app, VS Code extension, IDE plugin

The dashboard and CLI are the product surfaces for this phase.

## One-off features for a single customer

Prefer repo overlays (`.coro/`) or tenant-specific plugins over baking single-tenant behavior into core.
