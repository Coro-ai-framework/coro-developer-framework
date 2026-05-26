# Licensing notice

Coro uses an **open-core** model: most of the repository is open source under the
[Business Source License 1.1](LICENSE) (BUSL-1.1), with a dedicated commercial
license for the hosted control plane.

## Open source (BUSL-1.1 → Apache-2.0)

Everything in this repository **except** the path listed below is licensed under
BUSL-1.1. On **2029-05-19**, that code converts to [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).

**Copyright:** Emre Ertugrul (personal maintainer; may transfer to a company entity later.)

**What you can do today (plain English):**

- Clone, modify, and contribute to Coro.
- Run Coro locally or inside your organization for real engineering work.
- Build plugins and integrations using `@coro-ai/plugin-sdk`.

**What requires a commercial agreement:**

- Operating **Coro Cloud** (or a substantially equivalent multi-tenant hosted
  control plane for third parties) in production, whether hosted by you or sold
  as a service.

See the **Additional Use Grant** in [LICENSE](LICENSE) for the legal wording.

### In scope for BUSL

Includes, among others:

- `packages/runner/` (CLI, job engine, hybrid client — **not** `src/cloud/`)
- `packages/dashboard/`, `packages/desktop-electron/`
- `packages/intelligence-base/`, `packages/plugin-sdk/`, `packages/plugin-gitlab/`
- `packages/llm-anthropic/`, `packages/llm-openai/`
- `packages/cloud-protocol/` (shared protocol types used by OSS runners and Cloud)

## Commercial (source-available)

| Path | License |
|------|---------|
| `packages/runner/src/cloud/` | [Coro Cloud Commercial License](packages/runner/src/cloud/LICENSE) |

This is the **Coro Cloud** control plane (auth, teams, webhooks, WebSocket gateway,
Postgres backend). Source is published for transparency; production use requires a
commercial agreement.

## SPDX headers

Source files may include SPDX identifiers:

- `BUSL-1.1` — open-core code
- `LicenseRef-Coro-Commercial-1.0` — `packages/runner/src/cloud/` only

## Trademarks

“Coro” and related marks are not licensed by the copyright licenses above. Do not
imply endorsement or official status without permission.

## Questions

- **Licensing / commercial:** open a GitHub Discussion or issue with the `question` label.
- **Security:** see [SECURITY.md](SECURITY.md).
