import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ExecutorSandboxReport } from '@coro-ai/plugin-sdk'

/**
 * Detects whether a host-enforced Bash sandbox will be active for this
 * job despite the executor asking for `sandbox: { enabled: false }`.
 *
 * ## Why this is a settings read and not a write attempt
 *
 * The obvious probe — try to write a temp file under `~/go` and see if it
 * fails — does not work here, and quietly reports the wrong answer. The
 * sandbox is applied by the Claude Code CLI to the commands *it* spawns
 * for the `Bash` tool; the Coro runner process is the CLI's parent and is
 * not confined by it. A write from this process succeeds even when every
 * equivalent write from the agent's shell is denied.
 *
 * So we inspect the thing that actually decides the outcome: the settings
 * layers Coro cannot override. The SDK forwards our `sandbox` option as
 * `--settings`, which lands in the *flag* layer — the highest priority
 * among **user-controlled** sources. Managed sources (MDM / enterprise
 * `managed-settings.json`, and the org policy the CLI fetches from the
 * server into `remote-settings.json`) load into the *policy* layer, which
 * user-controlled layers are not allowed to widen. If `sandbox.enabled` is
 * true in either of those, our disable request loses and the agent will
 * hit `operation not permitted` on the first write outside its working
 * directory.
 */

/** Enterprise-managed settings, installed by MDM or an IT admin. */
function managedSettingsPath(): string {
  switch (process.platform) {
    case 'darwin':
      return '/Library/Application Support/ClaudeCode/managed-settings.json'
    case 'win32':
      return path.join(
        process.env['PROGRAMDATA'] ?? 'C:\\ProgramData',
        'ClaudeCode',
        'managed-settings.json',
      )
    default:
      return '/etc/claude-code/managed-settings.json'
  }
}

/** Org policy the CLI fetches at startup and caches on disk. */
function remoteSettingsPath(): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'remote-settings.json')
}

interface SandboxSettingsShape {
  enabled?: boolean
  allowUnsandboxedCommands?: boolean
  excludedCommands?: string[]
  network?: { allowedDomains?: string[]; allowManagedDomainsOnly?: boolean }
  filesystem?: { allowWrite?: string[] }
}

function readSandboxSettings(file: string): SandboxSettingsShape | null {
  let raw: string
  try {
    raw = readFileSync(file, 'utf-8')
  } catch {
    // Absent or unreadable is the common case — no managed policy here.
    return null
  }
  try {
    const parsed = JSON.parse(raw) as { sandbox?: SandboxSettingsShape }
    return parsed?.sandbox ?? null
  } catch {
    // A corrupt policy file is the host's problem, not ours. Treat it as
    // absent rather than failing the job.
    return null
  }
}

export interface ProbeOpts {
  /** Override the settings sources. Tests only. */
  sources?: ReadonlyArray<string>
}

/**
 * Returns a report when a host policy pins the sandbox on, or `null` when
 * nothing overrides the executor's request to disable it.
 */
export function probeHostSandbox(opts: ProbeOpts = {}): ExecutorSandboxReport | null {
  const files = opts.sources ?? [managedSettingsPath(), remoteSettingsPath()]

  const sources: string[] = []
  const allowedDomains = new Set<string>()
  const excludedCommands = new Set<string>()
  const allowWritePaths = new Set<string>()
  let definesAllowlist = false
  let blocksUnsandboxedCommands = false

  for (const file of files) {
    const sandbox = readSandboxSettings(file)
    if (!sandbox?.enabled) continue

    sources.push(file)
    if (sandbox.allowUnsandboxedCommands === false) blocksUnsandboxedCommands = true
    for (const cmd of sandbox.excludedCommands ?? []) excludedCommands.add(cmd)
    for (const p of sandbox.filesystem?.allowWrite ?? []) allowWritePaths.add(p)

    const domains = sandbox.network?.allowedDomains
    if (domains && domains.length > 0) {
      definesAllowlist = true
      for (const d of domains) allowedDomains.add(d)
    }
  }

  if (sources.length === 0) return null

  return {
    sources,
    // Every sandbox profile we know of confines writes to the working
    // directory. Extra grants are reported separately below.
    restrictsWritesOutsideWorkingDir: true,
    ...(definesAllowlist ? { allowedDomains: [...allowedDomains].sort() } : {}),
    ...(excludedCommands.size > 0 ? { excludedCommands: [...excludedCommands].sort() } : {}),
    ...(allowWritePaths.size > 0 ? { allowWritePaths: [...allowWritePaths].sort() } : {}),
    ...(blocksUnsandboxedCommands ? { blocksUnsandboxedCommands: true } : {}),
  }
}
