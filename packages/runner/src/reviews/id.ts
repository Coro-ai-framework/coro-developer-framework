import { createHash } from 'crypto'
import type { ExternalRef } from '@coro-ai/cloud-protocol'

export function reviewIdFor(ref: ExternalRef, login: string): string {
  const hash = createHash('sha256')
    .update(`${ref.pluginId}\0${ref.repoKey ?? ''}\0${ref.externalId}\0${login}`)
    .digest('hex')
    .slice(0, 16)
  return `rev_${hash}`
}

export function findingFingerprint(path: string | undefined, title: string, category: string): string {
  const normalised = title.trim().toLowerCase().replace(/\s+/g, ' ')
  return createHash('sha256')
    .update(`${category}\0${path ?? ''}\0${normalised}`)
    .digest('hex')
    .slice(0, 16)
}

export function findingId(): string {
  return `f_${createHash('sha256').update(`${Date.now()}:${Math.random()}`).digest('hex').slice(0, 8)}`
}

/** Parse `owner/repo#123` or an https URL into a ref. GitHub-shaped; other hosts keep the path. */
export function parsePrUrl(input: string, pluginId = 'github'): ExternalRef | null {
  const trimmed = input.trim()
  const hash = trimmed.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/)
  if (hash) {
    return {
      kind: 'pull_request',
      pluginId,
      repoKey: `${hash[1]}/${hash[2]}`,
      externalId: hash[3],
      url: `https://github.com/${hash[1]}/${hash[2]}/pull/${hash[3]}`,
    }
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  const parts = url.pathname.split('/').filter(Boolean)
  const pullAt = parts.findIndex(part => part === 'pull' || part === 'pulls' || part === 'merge_requests')
  if (pullAt < 2 || !parts[pullAt + 1] || !/^\d+$/.test(parts[pullAt + 1]!)) return null
  const host = url.hostname
  const inferred = host.includes('gitlab') ? 'gitlab' : host.includes('bitbucket') ? 'bitbucket' : pluginId
  return {
    kind: 'pull_request',
    pluginId: inferred,
    repoKey: `${parts[0]}/${parts[1]}`,
    externalId: parts[pullAt + 1]!,
    url: url.toString(),
  }
}
