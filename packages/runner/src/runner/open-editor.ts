// ── Local editor detection + open ────────────────────────────────────────────
//
// Powers the dashboard "Open in VS Code / Cursor" affordance on the Changes
// tab. Only meaningful in *local* mode, where the runner shares a filesystem
// (and a desktop session) with the developer: the runner can then both detect
// which editor CLIs are installed and launch one against the job's checkout.
//
// Security: `openInEditor` and `revealFolder` never receive a filesystem path
// that came from the network. The HTTP layer resolves the directory itself (from the jobId, with
// the same path-traversal guards as the diff endpoint) and only the *editor id*
// is client-supplied — and that is matched against this fixed allowlist.
// `resolveOpenablePath` below guards the one exception.

import { execFile, spawn } from 'node:child_process'
import fsSync from 'node:fs'
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

// ── Paths mentioned in plan mode ─────────────────────────────────────────────
//
// Here the path *is* client-supplied (the developer clicked it in a chat
// message), so it must resolve, after symlinks, to an existing location
// under one of the caller's roots, and is never handed to the OS default
// handler — that would launch an `.app`, `.command` or `.exe` the agent wrote.

export type OpenablePath = { ok: true; path: string } | { ok: false; status: number; error: string }

function realpathOrNull(p: string): string | null {
  try {
    return fsSync.realpathSync(p)
  } catch {
    return null
  }
}

export function resolveOpenablePath(raw: string, roots: Array<string | undefined>): OpenablePath {
  const expanded = raw === '~' || raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(1)) : raw
  if (!path.isAbsolute(expanded)) return { ok: false, status: 400, error: 'Path must be absolute' }
  const target = realpathOrNull(path.resolve(expanded))
  if (!target) return { ok: false, status: 404, error: 'That path no longer exists' }
  const inside = roots.some(root => {
    const real = root ? realpathOrNull(root) : null
    return real !== null && (target === real || target.startsWith(real + path.sep))
  })
  return inside
    ? { ok: true, path: target }
    : { ok: false, status: 403, error: 'Coro only opens paths in this conversation’s scratch directory, your home folder, or its working directory' }
}

export interface LocalOpenCommand {
  cmd: string
  args: string[]
  opened: 'folder' | 'editor' | 'reveal'
}

/** A folder opens in the file manager; a file in the editor, else selected in the file manager. */
export function planLocalOpen(
  target: string,
  isDirectory: boolean,
  platform: NodeJS.Platform,
  editor: DetectedEditor | undefined,
): LocalOpenCommand {
  if (isDirectory) {
    // A macOS bundle (`Foo.app`) is a directory that `open` would launch.
    if (platform === 'darwin' && path.extname(target)) return { cmd: 'open', args: ['-R', target], opened: 'reveal' }
    if (platform === 'darwin') return { cmd: 'open', args: [target], opened: 'folder' }
    if (platform === 'win32') return { cmd: 'explorer', args: [target], opened: 'folder' }
    return { cmd: 'xdg-open', args: [target], opened: 'folder' }
  }
  if (editor?.cli) return { cmd: editor.cli, args: [target], opened: 'editor' }
  if (editor?.macApp && platform === 'darwin') return { cmd: 'open', args: ['-a', editor.macApp, target], opened: 'editor' }
  if (platform === 'darwin') return { cmd: 'open', args: ['-R', target], opened: 'reveal' }
  if (platform === 'win32') return { cmd: 'explorer', args: [`/select,${target}`], opened: 'reveal' }
  return { cmd: 'xdg-open', args: [path.dirname(target)], opened: 'reveal' }
}

export async function openLocalPath(target: string): Promise<LocalOpenCommand['opened']> {
  const stat = await fs.stat(target)
  const editor = stat.isDirectory() ? undefined : (await detectEditors())[0]
  const plan = planLocalOpen(target, stat.isDirectory(), process.platform, editor)
  launchDetached(plan.cmd, plan.args)
  return plan.opened
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
