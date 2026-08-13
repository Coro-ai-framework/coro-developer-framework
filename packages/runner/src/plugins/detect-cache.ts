// ── Credential detection cache ───────────────────────────────────────────────
//
// Raw {@link CredentialCandidate.config} values from plugin.detectCredentials()
// are cached server-side so the dashboard never receives secrets. Candidates
// expire after a short TTL; apply-after-expiry returns 410.

import type { CredentialCandidate } from './types'

const TTL_MS = 10 * 60 * 1000

interface CacheEntry {
  candidate: CredentialCandidate
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

function cacheKey(pluginId: string, candidateId: string): string {
  return `${pluginId}:${candidateId}`
}

export function storeDetectCandidates(
  pluginId: string,
  candidates: ReadonlyArray<CredentialCandidate>,
): void {
  const expiresAt = Date.now() + TTL_MS
  for (const candidate of candidates) {
    cache.set(cacheKey(pluginId, candidate.id), { candidate, expiresAt })
  }
}

export function takeDetectCandidate(
  pluginId: string,
  candidateId: string,
): CredentialCandidate | null {
  const key = cacheKey(pluginId, candidateId)
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    cache.delete(key)
    return null
  }
  cache.delete(key)
  return entry.candidate
}

/** Test helper — clear all cached entries. */
export function clearDetectCache(): void {
  cache.clear()
}
