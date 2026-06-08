# Desktop Packaging And Release Notes

This document captures the current desktop distribution shape for Coro and the
next platform extension work, with emphasis on Windows packaging.

## Current State

- The shipping desktop shell is Electron-based and wraps the existing runner and
  dashboard.
- macOS arm64 is the only production platform currently wired end to end.
- Windows x64 packaging is now supported through GitHub Actions runners, so a
  local Windows machine is not required to create installer artifacts.
- Production releases are signed, notarized, published to the public releases
  repository, and verified to auto-update successfully.
- User state remains under `~/.coro`, matching the CLI and existing local
  runtime expectations.

## Current macOS Release Surface

- Build package: `packages/desktop-electron`
- Packaging config: `packages/desktop-electron/electron-builder.json5`
- Validation workflow: `.github/workflows/desktop-validation.yml`
- Release workflow: `.github/workflows/desktop-release.yml`
- Public update repo: `Coro-ai-framework/coro-release`
- Published artifacts today:
  - `Coro-<version>-arm64.dmg`
  - `Coro-<version>-arm64.zip`
  - `*.blockmap`
  - `latest-mac.yml`

The macOS updater path uses `electron-updater` against GitHub Releases. The app
checks at startup, downloads in the background, prompts when the update is
ready, and installs on restart or app quit.

## Operator Notes

The current operator workflow is:

1. Trigger `.github/workflows/desktop-release.yml` manually with the target
  semantic version and a `platforms` value.
2. Provide a release type of `release`, `prerelease`, or `draft`.
3. Let the workflow temporarily rewrite the desktop package version for the
  build and publish the artifacts to the public releases repo.
4. For macOS releases, the workflow also signs and notarizes the app.
5. For Windows releases, the workflow builds on a Windows runner and publishes
  NSIS installer artifacts. If Windows signing secrets are present, it signs
  the installer during the same workflow run.
6. Verify the public release includes the platform-appropriate updater metadata
  and binaries.
7. Validate the installed app updates from the previously released version.

Valid `platforms` examples:

- `macos`
- `windows`
- `macos,windows`

Required secrets already used by the workflow:

- `CORO_RELEASE_GITHUB_TOKEN`
- `APPLE_SIGNING_CERT_B64`
- `APPLE_SIGNING_CERT_PASSWORD`
- `APPLE_API_KEY_B64`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

Optional Windows signing secrets:

- `WINDOWS_SIGNING_CERT_B64`
- `WINDOWS_SIGNING_CERT_PASSWORD`

## Windows Packaging Focus

Windows packaging is now intended to happen primarily in GitHub Actions. That is
the correct default if there is no dedicated local Windows machine available.

### Recommended Windows Packaging Shape

- Target installer: `nsis`
- Update mechanism: `electron-updater` with NSIS artifacts
- Primary architectures:
  - `x64` first
  - `arm64` later if there is demand and a stable Windows-on-ARM test path
- Release channel: reuse the existing public GitHub releases repository unless a
  Windows-specific distribution constraint appears

This is now reflected in the desktop workflows:

- `.github/workflows/desktop-validation.yml` builds Windows x64 artifacts on a
  Windows runner for validation.
- `.github/workflows/desktop-release.yml` can publish Windows x64 artifacts when
  dispatched with `platforms=windows`.
- `.github/workflows/desktop-release.yml` can publish both platforms for the
  same version from one dispatch with `platforms=macos,windows`.

`nsis` is the recommended Windows target because it is the updater path that
`electron-updater` supports well for packaged Electron apps. We should not plan
around Squirrel.Windows.

### Expected Windows Artifacts

Once implemented, the expected release outputs should look like:

- `Coro-<version>-x64.exe`
- `Coro-<version>-x64.nsis.7z` or other updater side artifacts emitted by
  electron-builder
- `latest.yml`
- optional blockmap artifacts if emitted by the chosen target/config

Unlike macOS, Windows updater metadata is expected in `latest.yml` rather than
`latest-mac.yml`.

### Required Packaging Changes

The Windows packaging baseline now includes:

1. A `win` target in `packages/desktop-electron/electron-builder.json5` using
  NSIS on `x64`.
2. Windows packaging scripts in `packages/desktop-electron/package.json`.
3. Cross-platform icon generation that emits a Windows `.ico` asset as part of
  the desktop build.
4. A packaged sidecar that runs the runner via the signed Electron binary in
   Node mode (`ELECTRON_RUN_AS_NODE=1`) — no separate unsigned `node.exe` copy.
5. Windows validation and release jobs in GitHub Actions.
6. A post-bundle assertion that the platform-specific Claude Agent SDK binary
   (`claude` / `claude.exe`) is present in the runner resource tree.
7. A `prebuild-install` step in `prepare-resources.mjs` that fetches the
   `better-sqlite3` binary matching the packaged Electron version, plus a probe
   that loads `:memory:` under `ELECTRON_RUN_AS_NODE` — not the build-host Node
   used by `npm install`.

**Native modules:** The runner sidecar does not run under system Node. It uses
Electron's embedded Node via `ELECTRON_RUN_AS_NODE=1`. Only `better-sqlite3`
needs an Electron-targeted binary; the Claude SDK ships as a standalone
executable. Desktop currently pins **Electron 41.7.1** (ABI 145) because
`better-sqlite3` prebuilds for Electron 42 (ABI 146) were rolled back upstream
([WiseLibs/better-sqlite3#1470](https://github.com/WiseLibs/better-sqlite3/pull/1470));
revisit Electron 42 once upstream ships v146 prebuilds or a compile fix lands.

Global `npm install -g @coro-ai/runner` is separate — its postinstall rebuilds
for the consumer's system Node, not Electron.

The remaining code-level validation work is behavioral rather than structural:

1. Validate sidecar start/stop behavior under Windows process semantics,
   especially around quit-and-install and child-process termination.
2. Confirm the published Windows updater flow across two real releases.

### Required Release Infrastructure

Windows production releases need code signing before they should be treated as
first-class downloadable builds. Unsigned installers trigger Windows SmartScreen
("Windows protected your PC") and Microsoft Defender may quarantine the bundled
`claude.exe` native binary on first run.

The runner binds **loopback only** (`127.0.0.1`) — Windows Firewall does not
prompt for loopback listeners and should not be the primary install blocker.

#### Signed path (recommended)

When signing secrets are configured, `.github/workflows/desktop-release.yml`
exports `CSC_LINK` and `CSC_KEY_PASSWORD` for electron-builder, which signs the
NSIS installer and application binaries.

Certificate options:

1. **Azure Trusted Signing** (recommended for new setups) — cloud-hosted
   Authenticode signing without a physical USB token. Configure the signing
   account in Azure, export credentials for CI, and wire them into the
   workflow's `CSC_*` environment (same slots electron-builder already reads).
2. **OV/EV `.pfx` certificate** — use the existing repository secrets:
   - `WINDOWS_SIGNING_CERT_B64` (base64-encoded `.pfx`)
   - `WINDOWS_SIGNING_CERT_PASSWORD`

After the first signed releases accumulate download reputation, SmartScreen
warnings diminish for most users.

#### Unsigned path (fallback / development)

When signing secrets are absent, the workflow publishes unsigned artifacts
(`WINDOWS_SIGNING_ENABLED=false`). Operators and early testers should:

1. On SmartScreen, choose **More info → Run anyway** for the installer.
2. If Defender quarantines `claude.exe` after install, add a Defender exclusion
   for the install directory (typically `%LOCALAPPDATA%\Programs\Coro\`) or
   restore the file from quarantine and re-run the installer.
3. As a last resort, set `CLAUDE_CODE_CLI_PATH` to a working `claude.exe` on
   the machine before starting Coro.

Unsigned builds are suitable for internal CI validation only — not public
distribution.

### Validation Checklist For Windows

Before calling Windows packaging complete, we should verify:

1. Fresh install on a clean Windows machine.
2. Runner sidecar boots and dashboard loads.
3. State persists under the intended Coro data directory without regressing the
   CLI compatibility model.
4. Auto-update from one published Windows version to the next succeeds.
5. App restart during update does not leave the UI alive against a dead runner.
6. Signed installer and installed app pass Windows signature verification.

## Windows Risks To Watch

- Windows process shutdown behavior differs from macOS and is more sensitive to
  installer/updater timing.
- Code signing on Windows is a user trust issue as much as a packaging issue;
  unsigned builds may work technically while still producing a poor install
  experience.
- If we support both `x64` and `arm64`, release validation cost rises
  immediately because updater metadata and artifact coverage must be confirmed for
  both targets.

## macOS Hardened Runtime

Production mac builds use `build/entitlements.mac.plist` with hardened runtime
enabled. The sidecar runs via `ELECTRON_RUN_AS_NODE=1` and spawns the bundled
`claude` binary from `extraResources` — both require entitlements that disable
library validation for helper binaries.

`scripts/verify-mac-signing.mjs` runs as an `afterSign` hook when `CSC_LINK` is
set, verifying codesign on the app bundle and the bundled Claude binary.

**Note:** macOS releases target **arm64 only** today. Intel Macs are not
supported by the current build matrix.

## Suggested Implementation Order

1. Use the Windows validation job to confirm `x64` packaging stays healthy.
2. Add Windows signing (Azure Trusted Signing or `.pfx` secrets) and confirm
  signed publish behavior in `.github/workflows/desktop-release.yml`.
3. Verify updater behavior across two real Windows releases.
4. Evaluate whether Windows `arm64` is worth adding.

## Out Of Scope For This Document

- Linux desktop packaging
- tray integration
- background updater UI improvements
- release channels beyond the default latest channel
