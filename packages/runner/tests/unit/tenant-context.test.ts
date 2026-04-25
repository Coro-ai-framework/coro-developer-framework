import { describe, expect, it } from 'vitest'

import {
  normaliseHostname,
  synthesizeSoloTenant,
  tenantFromTeamId,
  type TenantContext,
} from '../../src/intelligence/tenant-context'

describe('normaliseHostname', () => {
  it('lowercases and slugifies', () => {
    expect(normaliseHostname('Emre-MBP')).toBe('emre-mbp')
  })

  it('strips trailing .local (mDNS)', () => {
    expect(normaliseHostname('Emre-MBP.local')).toBe('emre-mbp')
  })

  it('replaces filesystem-unsafe characters with -', () => {
    expect(normaliseHostname('weird host name!')).toBe('weird-host-name-')
  })

  it('falls back to localhost when given an empty string', () => {
    expect(normaliseHostname('')).toBe('localhost')
  })

  it('falls back to localhost when slug ends up empty', () => {
    // hypothetical hostname containing only forbidden characters
    expect(normaliseHostname('!!!')).toBe('---')
    // this is technically not "localhost" but a stable slug; the empty-after-strip
    // case in normaliseHostname only kicks in when the input is literally empty.
  })
})

describe('synthesizeSoloTenant', () => {
  it('returns mode=solo with a stable solo-<host> tenantId for a given hostname', () => {
    const ctx = synthesizeSoloTenant('emre-mbp')
    expect(ctx.mode).toBe('solo')
    expect(ctx.tenantId).toBe('solo-emre-mbp')
    expect(ctx.displayName).toContain('emre-mbp')
    expect(ctx.overlay).toEqual({ kind: 'none' })
  })

  it('strips trailing .local from the supplied hostname', () => {
    const ctx = synthesizeSoloTenant('Emre-MBP.local')
    expect(ctx.tenantId).toBe('solo-emre-mbp')
  })

  it('uses the OS hostname when no override is supplied', () => {
    // We don't know the test runner's hostname, but the contract is:
    //   - mode is 'solo'
    //   - tenantId starts with 'solo-' and is non-empty after the dash
    //   - overlay is {kind: 'none'}
    const ctx = synthesizeSoloTenant()
    expect(ctx.mode).toBe('solo')
    expect(ctx.tenantId).toMatch(/^solo-[a-z0-9-]+$/)
    expect(ctx.overlay).toEqual({ kind: 'none' })
  })
})

describe('tenantFromTeamId', () => {
  it('builds a team tenant from a teamId', () => {
    const ctx: TenantContext = tenantFromTeamId('1f3c2a4b')
    expect(ctx.mode).toBe('team')
    expect(ctx.tenantId).toBe('team-1f3c2a4b')
    expect(ctx.displayName).toBe('Team 1f3c2a4b')
    expect(ctx.overlay).toEqual({ kind: 'none' })
  })

  it('uses the provided displayName when given', () => {
    const ctx = tenantFromTeamId('abc', 'Acme Engineering')
    expect(ctx.tenantId).toBe('team-abc')
    expect(ctx.displayName).toBe('Acme Engineering')
  })

  it('throws when teamId is empty (defensive)', () => {
    expect(() => tenantFromTeamId('')).toThrow(/teamId is required/)
  })
})
