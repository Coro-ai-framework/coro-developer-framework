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

/** Absolute working directory for one job: `{workingDirRoot}/{jobId}`. */
export function jobWorkingDir(workingDirRoot: string, jobId: string): string {
  return path.resolve(workingDirRoot, jobId)
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
  const resolved = path.resolve(root, rawPath)
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new ArtifactPathEscapeError()
  }
  return resolved
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
