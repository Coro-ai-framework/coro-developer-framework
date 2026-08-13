import { describe, it, expect } from 'vitest'
import { JobType } from '@coro-ai/cloud-protocol'
import type { Job } from '@coro-ai/cloud-protocol'
import { buildSanitizer, collectRepoSlugs, createSanitizer } from '../../src/tools/sanitize'
import type { Settings } from '../../src/config/settings'
import { makeMockJob } from '../mcp/fixtures'

const SETTINGS = {
  bitbucket: { workspace: 'acme-internal' },
  github: { owner: 'acme-gh' },
} as unknown as Pick<Settings, 'bitbucket' | 'github'>

describe('createSanitizer', () => {
  const sanitizer = createSanitizer({
    repoSlugs: ['acme/billing-api', 'payments-svc'],
    orgs: ['acme'],
    tenantId: 'solo-acme-laptop',
  })

  it('replaces repo slugs with stable aliases', () => {
    // Sorted input → 'acme/billing-api' is repo-A, 'payments-svc' is repo-B.
    expect(sanitizer.apply('cloned acme/billing-api')).toBe('cloned repo-A')
    expect(sanitizer.apply('cloned payments-svc')).toBe('cloned repo-B')
    expect(sanitizer.repoAlias('payments-svc')).toBe('repo-B')
  })

  it('prefers the longest identifier so org-prefixed slugs are not half-replaced', () => {
    expect(sanitizer.apply('acme/billing-api')).toBe('repo-A')
  })

  it('replaces org names, tenant ids, ticket keys, and emails', () => {
    const out = sanitizer.apply('acme workspace, tenant solo-acme-laptop, PROJ-412, dev@acme.io')
    expect(out).toBe('org-A workspace, tenant <tenant>, ticket-ref-1, <redacted-email>')
  })

  it('keeps repeated ticket keys correlated', () => {
    const fresh = createSanitizer({ repoSlugs: [], orgs: [] })
    expect(fresh.apply('AB-1 then CD-2 then AB-1')).toBe('ticket-ref-1 then ticket-ref-2 then ticket-ref-1')
  })

  it('reports leaks for every identifier class', () => {
    const leaks = sanitizer.findLeaks('acme/billing-api broke on PROJ-9, ask dev@acme.io')
    expect(leaks.map(l => l.kind).sort()).toEqual(['email', 'org', 'repo', 'ticket'])
  })

  it('finds no leaks in its own output — apply and findLeaks agree', () => {
    const raw = 'acme/billing-api + payments-svc + PROJ-1 + dev@acme.io + solo-acme-laptop'
    expect(sanitizer.findLeaks(sanitizer.apply(raw))).toEqual([])
  })

  it('is a no-op on text with nothing to hide', () => {
    expect(sanitizer.apply('the coding phase ran 5 times')).toBe('the coding phase ran 5 times')
    expect(sanitizer.findLeaks('the coding phase ran 5 times')).toEqual([])
  })

  it('labels more than 26 repos without collisions', () => {
    const many = Array.from({ length: 30 }, (_, i) => `svc-${String(i).padStart(2, '0')}`)
    const wide = createSanitizer({ repoSlugs: many, orgs: [] })
    const aliases = many.map(slug => wide.repoAlias(slug))
    expect(new Set(aliases).size).toBe(30)
    expect(aliases[25]).toBe('repo-Z')
    expect(aliases[26]).toBe('repo-AA')
  })
})

describe('collectRepoSlugs', () => {
  it('reads slugs from params and from PR mappings', () => {
    const jobs = [
      makeMockJob({ params: { repoSlug: 'from-params' } }),
      makeMockJob({
        params: {},
        prMappings: [{ prId: 1, workItem: 'wi', repoSlug: 'from-pr', openedAt: '2026-01-01T00:00:00Z' }],
      }),
      makeMockJob({ params: { repo: 'from-repo-key' } }),
    ] as unknown as Job[]
    expect(Array.from(collectRepoSlugs(jobs)).sort()).toEqual(['from-params', 'from-pr', 'from-repo-key'])
  })
})

describe('buildSanitizer', () => {
  it('covers job repo slugs plus configured orgs and the tenant id', () => {
    const jobs = [makeMockJob({ type: JobType.Job, params: { repoSlug: 'billing-api' } })] as unknown as Job[]
    const sanitizer = buildSanitizer(jobs, SETTINGS, 'solo-host')
    const leaks = sanitizer.findLeaks('billing-api in acme-internal / acme-gh for solo-host')
    expect(leaks.map(l => l.kind).sort()).toEqual(['org', 'org', 'repo', 'tenant'])
  })
})
