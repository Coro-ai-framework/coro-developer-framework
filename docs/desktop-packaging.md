# Desktop Packaging And Release Notes

This document captures the current desktop distribution shape for Coro across
macOS, Windows, and Linux.

## Current State

- The shipping desktop shell is Electron-based and wraps the existing runner and
  dashboard.
- **macOS arm64**, **Windows x64**, and **Linux x64 (AppImage)** are wired
  through GitHub Actions for validation and release.
- macOS releases are signed and notarized; Windows signing is optional via CI
  secrets; Linux v1 ships unsigned (same optional-signing posture as unsigned
  Windows).
- Production releases publish to the public releases repository and use
  `electron-updater` per platform (`latest-mac.yml`, `latest.yml`,
  `latest-linux.yml`).
- User state remains under `~/.coro`, matching the CLI and existing local
  runtime expectations.

## Current macOS Release Surface

- Build package: `packages/desktop-electron`
- Packaging config: `packages/desktop-electron/electron-builder.json5`
- Validation workflow: `.github/workflows/desktop-validation.yml`
- Release workflow: `.github/workflows/desktop-release.yml`
- Public update repo: `Coro-ai-framework/coro-release`
- Published artifacts:
  - macOS: `Coro-<version>-arm64.dmg`, `Coro-<version>-arm64.zip`, `latest-mac.yml`
  - Windows: `Coro-<version>-x64.exe`, `latest.yml`
  - Linux: `Coro-<version>-x64.AppImage`, `latest-linux.yml`
  - `*.blockmap` where emitted by electron-builder

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
6. For Linux releases, the workflow builds on `ubuntu-latest` and publishes an
  AppImage. No Linux signing step in v1.
7. Verify the public release includes the platform-appropriate updater metadata
  and binaries.
8. Validate the installed app updates from the previously released version.

Valid `platforms` examples:

- `macos`
- `windows`
- `linux`
- `macos,windows,linux`

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
4. A packaged sidecar resource layout that resolves the bundled Node binary
   correctly on Windows, where the executable will be `node.exe`.
5. Windows validation and release jobs in GitHub Actions.

The remaining code-level validation work is behavioral rather than structural:

1. Validate sidecar start/stop behavior under Windows process semantics,
   especially around quit-and-install and child-process termination.
2. Confirm the published Windows updater flow across two real releases.

### Required Release Infrastructure

Windows production releases will also need signing before they should be treated
as first-class downloadable builds.

That implies:

- a code-signing certificate suitable for Windows executables
- CI secret material for the certificate and password
- runner support for secure certificate import during the release job
- post-build validation that SmartScreen reputation and signature verification
  are acceptable for distribution

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

## Suggested Implementation Order

1. Use the new Windows validation job to confirm unsigned `x64` packaging stays
  healthy on repository changes.
2. Add Windows signing secrets and confirm signed publish behavior in
  `.github/workflows/desktop-release.yml`.
3. Verify updater behavior across two real Windows releases.
4. Evaluate whether Windows `arm64` is worth adding.

## Linux Packaging (AppImage x64)

Linux packaging runs on Ubuntu GitHub Actions runners. A local Linux machine is
not required to produce release artifacts.

### Recommended Linux Packaging Shape

- Target: `appImage` on `x64`
- Update mechanism: `electron-updater` with AppImage artifacts and
  `latest-linux.yml` on `coro-release`
- Icon: `dist/icon.png` from `prepare-icon.mjs`

AppImage is the Linux target because it is the `electron-updater` path
electron-builder supports for auto-update (analogous to NSIS on Windows).

### Expected Linux Artifacts

- `Coro-<version>-x64.AppImage`
- `latest-linux.yml`
- optional `*.blockmap` files

### Install Notes For Users

1. Download `Coro-<version>-x64.AppImage` from
   [coro-release](https://github.com/Coro-ai-framework/coro-release/releases/latest).
2. `chmod +x Coro-*.AppImage` and run the file (or integrate via your desktop
   environment’s “Run” / AppImage launcher).
3. **FUSE:** many distributions require `libfuse2` (package name varies) to run
   AppImages. If the app fails to start, install FUSE and retry.
4. Packaged builds pass `--no-sandbox` because AppImage FUSE mounts cannot configure
   Chromium’s `chrome-sandbox` helper (required for the app to start).
5. **Auto-update:** until a release is published with `platforms=linux`, the app logs a
   single informational line instead of errors about missing `latest-linux.yml` on
   existing macOS/Windows-only releases.
6. **Wayland:** harmless `wayland_wp_color_manager` log lines from Chromium on some
   compositors can be ignored.

### Local / CI Commands

```bash
pnpm --filter @coro/desktop-electron dist:linux      # AppImage, no publish
pnpm --filter @coro/desktop-electron package:linux   # unpacked dir for debugging
pnpm --filter @coro/desktop-electron release:linux   # publish to coro-release
```

Validation workflow job: `package-linux` in
`.github/workflows/desktop-validation.yml`.

### Validation Checklist For Linux (before first public release)

Run on a clean Ubuntu 22.04 or 24.04 VM:

1. Fresh install from published AppImage (`chmod +x`, execute).
2. Runner sidecar boots and dashboard loads in the Electron window.
3. Settings persist under `~/.coro` without regressing CLI compatibility.
4. **Auto-update:** publish two sequential Linux versions via
   `platforms=linux`; confirm update download, “Restart and Install”, and
   successful restart on the newer version.
5. Quit during update does not leave the UI running against a dead runner.

## Out Of Scope For This Document

- `.deb` / Flatpak / Snap / Linux arm64 AppImage
- tray integration
- background updater UI improvements
- release channels beyond the default latest channel
