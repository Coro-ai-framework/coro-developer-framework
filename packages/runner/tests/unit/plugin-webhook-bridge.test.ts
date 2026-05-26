// ── Plugin webhook bridge (P4) ────────────────────────────────────────────────
//
// Covers `makePluginWebhookNormalizer` — the closure handed to the
// WebSocket transport that turns a raw plugin webhook frame into a
// fully-formed {@link InboundEvent}.

import { describe, it, expect, vi } from 'vitest'
import pino from 'pino'
import { z } from 'zod'
import { makePluginWebhookNormalizer } from '../../src/plugins/webhook-bridge'
import { PluginRegistry } from '../../src/plugins/registry'
import type {
  PluginManifest,
  ScmPluginRuntime,
} from '../../src/plugins/types'
import type { NormalizedEvent } from '@coro-ai/cloud-protocol'

const logger = pino({ level: 'silent' })

function manifest(id: string): PluginManifest {
  return {
    id,
    kind: 'scm',
    version: '0.0.0',
    displayName: id,
    hostCompatibility: '^1.0.0',
    configSchema: z.object({}),
  }
}

function makePluginWithNormalizer(
  id: string,
  normalizer: (req: { headers: Record<string, string | string[] | undefined>; rawBody: Buffer }) => NormalizedEvent | null,
): ScmPluginRuntime {
  return {
    manifest: manifest(id),
    kind: 'scm',
    init: async () => {},
    healthcheck: async () => ({ ok: true }),
    dispose: async () => {},
    cloneInfo: () => ({ url: '', envForGit: {} }),
    createPr: async () => ({ kind: 'pull_request', pluginId: id, repoKey: 'r', externalId: '1' }),
    getPrStatus: async () => ({ state: 'open', approvalCount: 0 }),
    listPrComments: async () => [],
    postPrComment: async () => ({ id: '0', body: '', createdAt: '', updatedAt: '' }),
    replyToComment: async () => ({ id: '0', body: '', createdAt: '', updatedAt: '' }),
    pollPr: async () => ({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] }),
    normalizeInbound: normalizer,
    matchesRemote: () => false,
  }
}

describe('makePluginWebhookNormalizer', () => {
  it('returns an InboundEvent with source="plugin" and the plugin-supplied ref', () => {
    const plugin = makePluginWithNormalizer('mock', () => ({
      ref: { kind: 'pull_request', pluginId: 'mock', repoKey: 'svc', externalId: '42' },
      kind: 'pr.merged',
      raw: { pullrequest: { id: 42 } },
      receivedAt: '2026-01-01T00:00:00Z',
    }))
    const registry = new PluginRegistry()
    registry.register(plugin)

    const normalize = makePluginWebhookNormalizer({ plugins: registry, logger })
    const event = normalize('mock', { 'x-event-key': 'pullrequest:fulfilled' }, Buffer.from('{}'))

    expect(event).not.toBeNull()
    expect(event?.source).toBe('plugin')
    expect(event?.pluginId).toBe('mock')
    expect(event?.eventKey).toBe('pr.merged')
    expect(event?.ref).toEqual({
      kind: 'pull_request',
      pluginId: 'mock',
      repoKey: 'svc',
      externalId: '42',
    })
    expect(event?.payload).toEqual({ pullrequest: { id: 42 } })
  })

  it('returns null when the plugin is not registered', () => {
    const registry = new PluginRegistry()
    const warnSpy = vi.spyOn(logger, 'warn')
    const normalize = makePluginWebhookNormalizer({ plugins: registry, logger })

    const event = normalize('missing', {}, Buffer.from('{}'))
    expect(event).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: 'missing' }),
      expect.stringContaining('unknown pluginId'),
    )
    warnSpy.mockRestore()
  })

  it('returns null when the plugin returns null (event ignored)', () => {
    const plugin = makePluginWithNormalizer('mock', () => null)
    const registry = new PluginRegistry()
    registry.register(plugin)

    const normalize = makePluginWebhookNormalizer({ plugins: registry, logger })
    const event = normalize('mock', {}, Buffer.from('{}'))

    expect(event).toBeNull()
  })

  it('passes headers + rawBody verbatim to the plugin', () => {
    const seen: Array<{ headers: Record<string, string | string[] | undefined>; rawBody: Buffer }> = []
    const plugin = makePluginWithNormalizer('mock', (req) => {
      seen.push(req)
      return null
    })
    const registry = new PluginRegistry()
    registry.register(plugin)

    const normalize = makePluginWebhookNormalizer({ plugins: registry, logger })
    const buf = Buffer.from('{"hello":"world"}')
    normalize('mock', { 'x-token': 'abc' }, buf)

    expect(seen).toHaveLength(1)
    expect(seen[0]!.headers).toEqual({ 'x-token': 'abc' })
    expect(seen[0]!.rawBody.equals(buf)).toBe(true)
  })
})
