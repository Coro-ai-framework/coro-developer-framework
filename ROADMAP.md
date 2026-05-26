# Roadmap

Themes for the next ~90 days (no dates — priorities may shift based on design-partner and contributor feedback).

## Help wanted

Coro is pre-1.0 and we are actively looking for people who can help in two ways:

### Extend the plugin surface

The runner is built around **SCM**, **tracker**, and **executor (LLM)** plugins ([README → Plugin architecture](README.md#plugin-architecture)). Today we ship GitHub and Jira as built-ins, GitLab as a reference SCM package, and Anthropic/OpenAI as executor plugins—but many teams need more:

| Kind | We'd love help with |
| ---- | ------------------- |
| **SCM** | Additional hosts (e.g. Bitbucket Server, Azure DevOps, Gitea), webhook edge cases, self-hosted variants |
| **Tracker** | Linear, GitHub Issues, Azure Boards, and other ticket systems |
| **Executor (LLM)** | More providers and aggregators (Bedrock, Azure OpenAI, Gemini, local models), with parity for phase execution and tool loops |

New integrations should be separate packages using [`@coro-ai/plugin-sdk`](packages/plugin-sdk/README.md); see [`packages/plugin-gitlab`](packages/plugin-gitlab/) for a full SCM example. Open a [Discussion](https://github.com/Coro-ai-framework/coro-developer-framework/discussions) before a large plugin if you want alignment on scope.

### Test Coro on real projects

We need feedback from **different codebases and stacks**—not just happy-path demos:

- Run the **desktop app** on macOS or Windows against your own repos
- Try solo workflows (`job`, `job-fast`, `job-deep`, `campaign`) and report what breaks
- Share stack context (language, monorepo vs polyrepo, SCM, tracker) when you file bugs or discussions

Even a short "I tried X on repo Y" write-up in Discussions is valuable before we widen the public launch.

---

## 1. First-run experience

- Desktop-first README and install path via [coro-release](https://github.com/Coro-ai-framework/coro-release/releases/latest)
- Friend-test the quick start on a machine that has never run Coro; fold fixes into docs
- Clear solo vs hybrid vs cloud setup paths in docs

## 2. Contributor-ready core

- CI that passes on forks without maintainer API keys
- Plugin authoring docs with `plugin-gitlab` as the reference (longer `docs/plugins.md` optional)
- Issue triage and CLA workflow stable for external PRs
- **Community plugin PRs** for SCM, tracker, and LLM integrations (see [Help wanted](#help-wanted))

## 3. Hosted Coro Cloud (commercial)

- Operable control plane deployment for design partners
- Team auth, webhooks, and runner connectivity hardened for multi-tenant use
- Paid tiers, SSO, and billing after design-partner validation

## How to influence the roadmap

- **Plugins or testing feedback** — [Discussions](https://github.com/Coro-ai-framework/coro-developer-framework/discussions) or a [bug report](https://github.com/Coro-ai-framework/coro-developer-framework/issues/new/choose) with repro details
- **Code** — [CONTRIBUTING.md](CONTRIBUTING.md) and sign the [CLA](CLA.md)
- **Large design changes** — RFC via Discussion before a big PR
