import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Thrown when an artefact `data.path` would resolve outside
 * `{workingDir}/{jobId}/`. Callers must refuse the read rather than
 * following the path.
 */
export class ArtifactPathEscapeError extends Error {
  constructor(message = 'Artifact path is outside the job working directory') {
    super(message)
    this.name = 'ArtifactPathEscapeError'
  }
}

/** Names omitted from job-workspace listings — huge and not useful to plan mode. */
const SKIP_LIST_NAMES = new Set(['.git'])

/** Absolute working directory for one job: `{workingDirRoot}/{jobId}`. */
export function jobWorkingDir(workingDirRoot: string, jobId: string): string {
  return path.resolve(workingDirRoot, jobId)
}

/**
 * Strip leading slashes so `path.resolve(jobDir, "/foo")` cannot jump to
 * the filesystem root. Empty / `.` / `/` mean the job directory itself.
 */
export function normalizeJobRelPath(rawPath: string): string {
  const trimmed = rawPath.trim()
  if (!trimmed || trimmed === '.' || trimmed === '/') return ''
  return trimmed.replace(/^[/\\]+/, '')
}

/**
 * Resolve `rawPath` under `{workingDirRoot}/{jobId}/`. Throws
 * {@link ArtifactPathEscapeError} if the result would leave that directory.
 */
export function resolveJobArtifactPath(
  workingDirRoot: string,
  jobId: string,
  rawPath: string,
): string {
  const root = jobWorkingDir(workingDirRoot, jobId)
  const rel = normalizeJobRelPath(rawPath)
  const resolved = rel ? path.resolve(root, rel) : root
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new ArtifactPathEscapeError()
  }
  return resolved
}

export async function jobWorkspaceExists(
  workingDirRoot: string,
  jobId: string,
): Promise<boolean> {
  try {
    const st = await fs.stat(jobWorkingDir(workingDirRoot, jobId))
    return st.isDirectory()
  } catch {
    return false
  }
}

/** Read a UTF-8 artefact file after confining `rawPath` to the job working dir. */
export async function readJobArtifactFile(
  workingDirRoot: string,
  jobId: string,
  rawPath: string,
): Promise<string> {
  const resolved = resolveJobArtifactPath(workingDirRoot, jobId, rawPath)
  return fs.readFile(resolved, 'utf-8')
}

export interface JobDirEntry {
  /** Path relative to the job working directory, POSIX separators. */
  path: string
  type: 'file' | 'dir'
  size?: number
}

/** List one directory under the job working dir. `.git` is omitted. */
export async function listJobWorkingDir(
  workingDirRoot: string,
  jobId: string,
  relPath = '',
): Promise<JobDirEntry[]> {
  const resolved = resolveJobArtifactPath(workingDirRoot, jobId, relPath)
  const st = await fs.stat(resolved)
  if (!st.isDirectory()) {
    throw new Error(`Not a directory: ${normalizeJobRelPath(relPath) || '.'}`)
  }
  const root = jobWorkingDir(workingDirRoot, jobId)
  const names = await fs.readdir(resolved)
  const entries: JobDirEntry[] = []
  for (const name of names) {
    if (SKIP_LIST_NAMES.has(name)) continue
    const abs = path.join(resolved, name)
    const rel = path.relative(root, abs).split(path.sep).join('/')
    try {
      const child = await fs.stat(abs)
      entries.push({
        path: rel,
        type: child.isDirectory() ? 'dir' : 'file',
        ...(child.isFile() ? { size: child.size } : {}),
      })
    } catch {
      continue
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

export interface JobFileSlice {
  text: string
  truncated: boolean
  offset: number
  totalChars: number
  nextOffset?: number
  binary?: boolean
}

const MAX_LOAD_BYTES = 2 * 1024 * 1024

/**
 * Read a UTF-8 slice of a confined job file. `offset` / `limit` are
 * character indexes into the decoded text (not bytes). Files larger
 * than 2 MiB are loaded only up to that cap.
 */
export async function readJobFileSlice(args: {
  workingDirRoot: string
  jobId: string
  rawPath: string
  offset?: number
  limit: number
}): Promise<JobFileSlice> {
  const resolved = resolveJobArtifactPath(args.workingDirRoot, args.jobId, args.rawPath)
  const st = await fs.stat(resolved)
  if (!st.isFile()) {
    throw new Error(`Not a file: ${normalizeJobRelPath(args.rawPath)}`)
  }

  const buf = st.size > MAX_LOAD_BYTES
    ? await readFilePrefix(resolved, MAX_LOAD_BYTES)
    : await fs.readFile(resolved)

  if (buf.includes(0)) {
    return { text: '', truncated: false, offset: 0, totalChars: 0, binary: true }
  }

  const full = buf.toString('utf-8')
  const offset = Math.max(0, Math.trunc(args.offset ?? 0))
  const slice = full.slice(offset, offset + args.limit)
  const loadedPartial = st.size > MAX_LOAD_BYTES
  const truncated = offset + slice.length < full.length || loadedPartial
  return {
    text: slice,
    truncated,
    offset,
    totalChars: full.length,
    ...(truncated ? { nextOffset: offset + slice.length } : {}),
  }
}

async function readFilePrefix(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}
