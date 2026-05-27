import type { Artifact } from '../types'
import { jsonRequest, requestJson, requestText } from './http'

/**
 * Process-wide cache for artefact file bodies, keyed by `${jobId}:${artifactId}`.
 *
 * - Stale-while-revalidate-ish: `Promise<string>` is stored during the
 *   in-flight fetch so concurrent callers share one network round-trip;
 *   the resolved value is then swapped in as a plain `string`.
 * - Mutating operations (saves) invalidate the entry so the next read
 *   re-fetches the canonical bytes from disk.
 *
 * Two surfaces use this today: the inline `ArtifactReviewPanel` shown on
 * interactive checkpoints, and the `ArtifactLink` modal opened from a
 * phase node. Sharing the cache means switching between them is instant.
 */
const contentCache = new Map<string, Promise<string> | string>()

function cacheKey(jobId: string, artifactId: string): string {
  return `${jobId}:${artifactId}`
}

/** Read the file the artefact registered, with caching. */
export async function fetchArtifactContent(jobId: string, artifactId: string): Promise<string> {
  const key = cacheKey(jobId, artifactId)
  const cached = contentCache.get(key)
  if (typeof cached === 'string') return cached
  if (cached) return cached

  const request = requestText(`/jobs/${jobId}/artifacts/${artifactId}/content`)
  contentCache.set(key, request)
  try {
    const text = await request
    contentCache.set(key, text)
    return text
  } catch (err) {
    contentCache.delete(key)
    throw err
  }
}

/**
 * Save a new body to disk via the runner. Returns the updated artefact
 * metadata (which now carries `editedAt` / `editedBy`) so callers can
 * patch their local job state without waiting for the next poll.
 */
export async function saveArtifactContent(
  jobId: string,
  artifactId: string,
  content: string,
): Promise<Artifact> {
  const response = await requestJson<{ artifact: Artifact }>(
    `/jobs/${jobId}/artifacts/${artifactId}/content`,
    jsonRequest({ content }, { method: 'PUT' }),
  )
  contentCache.set(cacheKey(jobId, artifactId), content)
  return response.artifact
}

/** Drop the cached body for one artefact (e.g. after a manual reload). */
export function invalidateArtifactContent(jobId: string, artifactId: string): void {
  contentCache.delete(cacheKey(jobId, artifactId))
}

/**
 * Convenience used by the dashboard: `data.path` indicates the artefact
 * has on-disk bytes the runner can stream; everything else (pr-link, url,
 * pure JSON blobs) is rendered without hitting the content endpoint.
 */
export function artifactHasFileBody(artifact: Artifact): boolean {
  const raw = artifact.data?.['path']
  return typeof raw === 'string' && raw.trim().length > 0
}

/** Best-effort flag for "render this as markdown" vs source. */
export function artifactIsMarkdown(artifact: Artifact): boolean {
  const rawPath = artifact.data?.['path']
  const pathStr = typeof rawPath === 'string' ? rawPath.toLowerCase() : ''
  return pathStr.endsWith('.md') || artifact.kind.endsWith('-md') || artifact.kind.includes('md')
}

/** Editable extension list mirrors the runner's allowlist (server.ts). */
const EDITABLE_EXTENSIONS = ['.md', '.txt', '.yml', '.yaml', '.json']

/**
 * Whether the dashboard should expose an Edit affordance for this artefact.
 * The server is the source of truth — it will refuse PUTs for unsupported
 * extensions — but mirroring the allowlist here keeps the UI honest.
 */
export function artifactIsEditable(artifact: Artifact): boolean {
  if (!artifactHasFileBody(artifact)) return false
  const pathStr = (artifact.data['path'] as string).toLowerCase()
  return EDITABLE_EXTENSIONS.some(ext => pathStr.endsWith(ext))
}
