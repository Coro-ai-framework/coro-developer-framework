// ── Deprecation cycle (P9) ───────────────────────────────────────────────────
//
// The plan ships `bb_*`, `gh_*`, `jira_*` MCP wrappers, the legacy
// `pr_mappings` / `jira_mappings` tables, and the legacy `git`/`tracker`
// config keys for **one full release** so workflows mid-flight keep
// working. This module centralises the knob that decides what each
// release does:
//
//   N    (current)   wrappers warn, tables read both new + old, configs read both
//   N+1              wrappers throw structured MCP errors, old tables fall back read-only,
//                    legacy config keys disappear from CLI prompts
//   N+2              wrappers removed, old tables dropped, legacy config keys hard-error
//
// Bumping a single env var (`CORO_DEPRECATION_STAGE`) flips the
// system between stages without ripping changes through every call
// site. The default is `'N'` so a fresh checkout reproduces v1
// behaviour exactly.
//
// Each call site that needs to branch on the stage reads through the
// helpers below — never the env var directly. That lets us add a
// centralised override later (e.g. cloud-pushed config) without
// hunting for branches.

export type DeprecationStage = 'N' | 'N+1' | 'N+2'

const VALID_STAGES: ReadonlySet<DeprecationStage> = new Set(['N', 'N+1', 'N+2'])

let cachedStage: DeprecationStage | undefined

function readStage(): DeprecationStage {
  const raw = process.env['CORO_DEPRECATION_STAGE']?.trim() ?? ''
  if (VALID_STAGES.has(raw as DeprecationStage)) {
    return raw as DeprecationStage
  }
  return 'N'
}

/**
 * The current deprecation stage. Cached on first read so flipping the
 * env var mid-process does not produce inconsistent behaviour across
 * call sites; tests can call {@link resetDeprecationStageCache} to
 * pick up a new value.
 */
export function getDeprecationStage(): DeprecationStage {
  if (cachedStage === undefined) {
    cachedStage = readStage()
  }
  return cachedStage
}

/**
 * Test-only — drop the cached stage so a `process.env` mutation in a
 * setup hook is observable.
 */
export function resetDeprecationStageCache(): void {
  cachedStage = undefined
}

// ── Per-feature predicates ───────────────────────────────────────────────────
//
// Call sites use these instead of inspecting the stage themselves so
// the behaviour matrix lives in one place.

/**
 * `bb_*` / `gh_*` / `jira_*` MCP shims:
 *  - N   → call legacy handler, log a deprecation line.
 *  - N+1 → throw a structured MCP error pointing at the new tool.
 *  - N+2 → tool is not registered at all (handled at registration time).
 */
export function legacyMcpWrapperBehaviour(): 'warn' | 'error' | 'remove' {
  switch (getDeprecationStage()) {
    case 'N': return 'warn'
    case 'N+1': return 'error'
    case 'N+2': return 'remove'
  }
}

/**
 * `pr_mappings` / `jira_mappings` tables:
 *  - N   → read+write to both old + new (`external_ref_mappings`).
 *  - N+1 → read-only fallback (writes go to new only).
 *  - N+2 → tables dropped; readers throw if they touch them.
 */
export function legacyMappingTablesBehaviour(): 'dual-write' | 'fallback-read' | 'gone' {
  switch (getDeprecationStage()) {
    case 'N': return 'dual-write'
    case 'N+1': return 'fallback-read'
    case 'N+2': return 'gone'
  }
}

/**
 * Legacy `git` / `tracker` top-level config keys:
 *  - N   → read both shapes; legacy translator fills in `plugins`.
 *  - N+1 → still parsed but the CLI no longer prompts for them.
 *  - N+2 → hard-error on encounter; users must migrate.
 */
export function legacyConfigKeysBehaviour(): 'read' | 'silent' | 'error' {
  switch (getDeprecationStage()) {
    case 'N': return 'read'
    case 'N+1': return 'silent'
    case 'N+2': return 'error'
  }
}

// ── Structured deprecation error ─────────────────────────────────────────────

/**
 * Stable error shape returned by N+1 wrappers. The agent framework's
 * MCP client surfaces `message` to the model verbatim; `replacement`
 * lets us include the new tool name in a machine-parseable place.
 */
export class DeprecatedMcpToolError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly replacement: string,
  ) {
    super(
      `MCP tool ${toolName} was removed in this Coro release. ` +
      `Call ${replacement} instead — it accepts the same arguments plus an optional pluginId.`,
    )
    this.name = 'DeprecatedMcpToolError'
  }
}
