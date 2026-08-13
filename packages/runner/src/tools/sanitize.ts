// ── Tenant identifier sanitisation ───────────────────────────────────────────
//
// The retrospective flow reads this install's own job history and can ship
// findings to a public repository. Anything that leaves the machine has to
// be scrubbed of company-identifying strings first: repository slugs, SCM
// workspace / org names, tracker ticket keys, e-mail addresses, and the
// tenant id.
//
// The same object does both halves of the job so the two directions can
// never drift apart:
//
//   apply(text)     → replace every known identifier with a stable alias.
//                     Used when building sanitised job reports.
//   findLeaks(text) → report identifiers still present in text. Used as a
//                     fail-closed gate before any public API call.
//
// Aliases are deliberately chosen so they do not themselves match the
// detection patterns (`ticket-ref-1`, not `TICKET-1`), which keeps
// `findLeaks(apply(text))` empty.

import type { Job } from '@coro-ai/cloud-protocol'
import type { Settings } from '../config/settings'

export type SanitizerLeakKind = 'repo' | 'org' | 'tenant' | 'ticket' | 'email'

export interface SanitizerLeak {
  kind: SanitizerLeakKind
  value: string
}

export interface Sanitizer {
  /** Replace every known tenant identifier with its stable alias. */
  apply(text: string): string
  /** Identifiers still present in `text`. Empty means safe to publish. */
  findLeaks(text: string): SanitizerLeak[]
  /** Stable alias for a repository slug (`repo-A`, `repo-B`, …). */
  repoAlias(slug: string): string
}

/** Tracker keys: `PROJ-123`, `AB1-9`. Uppercase-only to avoid matching prose. */
const TICKET_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g

const EMAIL_ALIAS = '<redacted-email>'
const TENANT_ALIAS = '<tenant>'

/**
 * Spreadsheet-style column label: 0 → A, 25 → Z, 26 → AA. Keeps aliases
 * short and readable however many repos an install has touched.
 */
function letterLabel(index: number): string {
  let n = index
  let out = ''
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/** Escape a literal string for embedding in a RegExp. */
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface SanitizerSources {
  /** Repository slugs seen anywhere in this install. */
  repoSlugs: Iterable<string>
  /** SCM workspace / organisation names from settings. */
  orgs: Iterable<string>
  tenantId?: string
}

export function createSanitizer(sources: SanitizerSources): Sanitizer {
  // Sort so aliases are deterministic across runs, then longest-first at
  // replacement time so `ws/svc-api` is consumed before `svc-api`.
  const repos = dedupeSorted(sources.repoSlugs)
  const orgs = dedupeSorted(sources.orgs)

  const repoAliases = new Map<string, string>()
  repos.forEach((slug, i) => repoAliases.set(slug, `repo-${letterLabel(i)}`))
  const orgAliases = new Map<string, string>()
  orgs.forEach((org, i) => orgAliases.set(org, `org-${letterLabel(i)}`))

  const tenantId = sources.tenantId?.trim() ?? ''

  // Literal identifiers, longest-first. Repo slugs commonly embed the org
  // name, so replacing them first prevents a half-substituted result.
  const literals: Array<{ kind: SanitizerLeakKind; value: string; alias: string }> = [
    ...repos.map(slug => ({ kind: 'repo' as const, value: slug, alias: repoAliases.get(slug)! })),
    ...orgs.map(org => ({ kind: 'org' as const, value: org, alias: orgAliases.get(org)! })),
    ...(tenantId ? [{ kind: 'tenant' as const, value: tenantId, alias: TENANT_ALIAS }] : []),
  ].sort((a, b) => b.value.length - a.value.length)

  // Ticket keys get a per-value alias so two mentions of the same ticket
  // stay correlated in the sanitised output.
  const ticketAliases = new Map<string, string>()
  const ticketAlias = (key: string): string => {
    const existing = ticketAliases.get(key)
    if (existing) return existing
    const alias = `ticket-ref-${ticketAliases.size + 1}`
    ticketAliases.set(key, alias)
    return alias
  }

  return {
    repoAlias(slug: string): string {
      return repoAliases.get(slug) ?? (slug ? `repo-${letterLabel(repos.length)}` : '')
    },

    apply(text: string): string {
      if (!text) return text
      let out = text
      for (const { value, alias } of literals) {
        out = out.replace(new RegExp(escapeRe(value), 'g'), alias)
      }
      out = out.replace(TICKET_RE, match => ticketAlias(match))
      out = out.replace(EMAIL_RE, EMAIL_ALIAS)
      return out
    },

    findLeaks(text: string): SanitizerLeak[] {
      if (!text) return []
      const found = new Map<string, SanitizerLeak>()
      for (const { kind, value } of literals) {
        if (text.includes(value)) found.set(`${kind}:${value}`, { kind, value })
      }
      for (const match of text.matchAll(TICKET_RE)) {
        found.set(`ticket:${match[0]}`, { kind: 'ticket', value: match[0] })
      }
      for (const match of text.matchAll(EMAIL_RE)) {
        found.set(`email:${match[0]}`, { kind: 'email', value: match[0] })
      }
      return Array.from(found.values())
    },
  }
}

function dedupeSorted(values: Iterable<string>): string[] {
  const set = new Set<string>()
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) set.add(trimmed)
  }
  return Array.from(set).sort()
}

/**
 * Collect every repository slug referenced by a set of jobs. Reads both
 * the `repoSlug` / `repo` params the CLI and dashboard set and the
 * `prMappings` entries the SCM tools append, so a job that cloned a repo
 * without a `repoSlug` param still contributes its identifier.
 */
export function collectRepoSlugs(jobs: ReadonlyArray<Job>): Set<string> {
  const slugs = new Set<string>()
  for (const job of jobs) {
    for (const key of ['repoSlug', 'repo'] as const) {
      const value = job.params?.[key]
      if (typeof value === 'string' && value.trim()) slugs.add(value.trim())
    }
    for (const pr of job.prMappings ?? []) {
      if (pr.repoSlug?.trim()) slugs.add(pr.repoSlug.trim())
    }
  }
  return slugs
}

/**
 * Build a sanitizer covering everything this install could leak: the repo
 * slugs of the supplied jobs plus the configured SCM org / workspace names
 * and the tenant id.
 */
export function buildSanitizer(
  jobs: ReadonlyArray<Job>,
  settings: Pick<Settings, 'bitbucket' | 'github'>,
  tenantId?: string,
): Sanitizer {
  const orgs = [settings.bitbucket?.workspace, settings.github?.owner]
    .filter((value): value is string => typeof value === 'string')
  return createSanitizer({
    repoSlugs: collectRepoSlugs(jobs),
    orgs,
    ...(tenantId ? { tenantId } : {}),
  })
}
