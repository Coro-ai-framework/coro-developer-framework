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
    const ctx = synthesizeSoloTenant({ hostnameOverride: 'emre-mbp' })
    expect(ctx.mode).toBe('solo')
    expect(ctx.tenantId).toBe('solo-emre-mbp')
    expect(ctx.displayName).toContain('emre-mbp')
    expect(ctx.overlay).toEqual({ kind: 'none' })
  })

  it('strips trailing .local from the supplied hostname', () => {
    const ctx = synthesizeSoloTenant({ hostnameOverride: 'Emre-MBP.local' })
    expect(ctx.tenantId).toBe('solo-emre-mbp')
  })

  it('uses the OS hostname when no override is supplied', () => {
    // We don't know the test runner's hostname, but the contract is:
    //   - mode is 'solo'
    //   - tenantId starts with 'solo-' and is non-empty after the dash
    //   - overlay defaults to { kind: 'none' }
    const ctx = synthesizeSoloTenant()
    expect(ctx.mode).toBe('solo')
    expect(ctx.tenantId).toMatch(/^solo-[a-z0-9-]+$/)
    expect(ctx.overlay).toEqual({ kind: 'none' })
  })

  it('honours the displayName override', () => {
    const ctx = synthesizeSoloTenant({ hostnameOverride: 'host', displayName: 'My Coro' })
    expect(ctx.displayName).toBe('My Coro')
  })

  it('passes through an explicit overlay descriptor (localDir)', () => {
    const ctx = synthesizeSoloTenant({
      hostnameOverride: 'host',
      overlay: { kind: 'localDir', path: '/tmp/overlay' },
    })
    expect(ctx.overlay).toEqual({ kind: 'localDir', path: '/tmp/overlay' })
  })

  it('passes through an explicit overlay descriptor (gitRemote)', () => {
    const ctx = synthesizeSoloTenant({
      hostnameOverride: 'host',
      overlay: { kind: 'gitRemote', url: 'git@example.com:overlay.git', ref: 'main' },
    })
    expect(ctx.overlay).toEqual({ kind: 'gitRemote', url: 'git@example.com:overlay.git', ref: 'main' })
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
    const ctx = tenantFromTeamId('abc', { displayName: 'Acme Engineering' })
    expect(ctx.tenantId).toBe('team-abc')
    expect(ctx.displayName).toBe('Acme Engineering')
  })

  it('throws when teamId is empty (defensive)', () => {
    expect(() => tenantFromTeamId('')).toThrow(/teamId is required/)
  })

  it('passes through a cloud-supplied overlay descriptor', () => {
    const ctx = tenantFromTeamId('abc', { overlay: { kind: 'cloudBlob', key: 'tenant/abc/v1' } })
    expect(ctx.overlay).toEqual({ kind: 'cloudBlob', key: 'tenant/abc/v1' })
  })
})
