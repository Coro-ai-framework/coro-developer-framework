// ── Local editor detection + open ────────────────────────────────────────────
//
// Powers the dashboard "Open in VS Code / Cursor" affordance on the Changes
// tab. Only meaningful in *local* mode, where the runner shares a filesystem
// (and a desktop session) with the developer: the runner can then both detect
// which editor CLIs are installed and launch one against the job's checkout.
//
// Security: callers never pass a filesystem path here that came from the
// network. The HTTP layer resolves the directory itself (from the jobId, with
// the same path-traversal guards as the diff endpoint) and only the *editor id*
// is client-supplied — and that is matched against this fixed allowlist.

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export interface EditorSpec {
  id: string
  name: string
  /** CLI executables to look for on PATH, in priority order. */
  bins: string[]
  /** macOS .app bundle name, used as a fallback via `open -a`. */
  macApp?: string
}

export interface DetectedEditor {
  id: string
  name: string
  /** Resolved CLI path when found on PATH; null when only the macOS app exists. */
  cli: string | null
  /** macOS app name to open via `open -a` when there is no CLI. */
  macApp: string | null
}

// VS Code-family editors that ship a folder-opening CLI (`<bin> <dir>` opens
// the directory as a workspace). Ordered by how common they are.
const EDITOR_SPECS: EditorSpec[] = [
  { id: 'code', name: 'VS Code', bins: ['code'], macApp: 'Visual Studio Code' },
  { id: 'cursor', name: 'Cursor', bins: ['cursor'], macApp: 'Cursor' },
  { id: 'code-insiders', name: 'VS Code Insiders', bins: ['code-insiders'], macApp: 'Visual Studio Code - Insiders' },
  { id: 'codium', name: 'VSCodium', bins: ['codium'], macApp: 'VSCodium' },
  { id: 'windsurf', name: 'Windsurf', bins: ['windsurf'], macApp: 'Windsurf' },
]

/** Resolve a binary on PATH, returning its absolute path or null. */
async function whichBin(bin: string): Promise<string | null> {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileP(finder, [bin])
    const first = stdout
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean)[0]
    return first || null
  } catch {
    return null
  }
}

/** Check whether a macOS .app bundle exists in the usual locations. */
async function macAppExists(appName: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  const candidates = [
    `/Applications/${appName}.app`,
    path.join(os.homedir(), 'Applications', `${appName}.app`),
  ]
  for (const c of candidates) {
    try {
      await fs.stat(c)
      return true
    } catch {
      // keep looking
    }
  }
  return false
}

async function probeEditor(spec: EditorSpec): Promise<DetectedEditor | null> {
  for (const bin of spec.bins) {
    const cli = await whichBin(bin)
    if (cli) return { id: spec.id, name: spec.name, cli, macApp: spec.macApp ?? null }
  }
  if (spec.macApp && (await macAppExists(spec.macApp))) {
    return { id: spec.id, name: spec.name, cli: null, macApp: spec.macApp }
  }
  return null
}

let cache: Promise<DetectedEditor[]> | null = null

/** Detect installed editors. Memoised for the process lifetime (cheap PATH probes). */
export function detectEditors(force = false): Promise<DetectedEditor[]> {
  if (force) cache = null
  if (!cache) {
    cache = Promise.all(EDITOR_SPECS.map(probeEditor)).then(results =>
      results.filter((e): e is DetectedEditor => e !== null),
    )
  }
  return cache
}

function launchDetached(cmd: string, args: string[]): void {
  // Detached + unref so the editor outlives the request and never blocks the
  // event loop. stdio ignored — we don't read the child's output.
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {
    /* surfaced to the caller via the availability check, not here */
  })
  child.unref()
}

/**
 * Open `dir` in the requested editor (or the first detected one when `editorId`
 * is omitted). Throws when no supported editor is available.
 */
export async function openInEditor(editorId: string | undefined, dir: string): Promise<DetectedEditor> {
  const editors = await detectEditors()
  if (editors.length === 0) {
    throw new Error('No supported editor (VS Code / Cursor) was detected on this machine')
  }
  const editor = editorId ? editors.find(e => e.id === editorId) : editors[0]
  if (!editor) {
    throw new Error(`Editor "${editorId}" is not available`)
  }
  if (editor.cli) {
    launchDetached(editor.cli, [dir])
  } else if (editor.macApp) {
    launchDetached('open', ['-a', editor.macApp, dir])
  } else {
    throw new Error(`Editor "${editor.id}" has no launch method`)
  }
  return editor
}

/** Reveal `dir` in the OS file manager (Finder / Explorer / xdg-open). */
export function revealFolder(dir: string): void {
  switch (process.platform) {
    case 'darwin':
      launchDetached('open', [dir])
      break
    case 'win32':
      launchDetached('explorer', [dir])
      break
    default:
      launchDetached('xdg-open', [dir])
  }
}
