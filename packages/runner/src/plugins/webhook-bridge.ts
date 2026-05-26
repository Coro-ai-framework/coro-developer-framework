// ── Webhook bridge ───────────────────────────────────────────────────────────
//
// Glue between a generic provider webhook (raw HTTP body + headers,
// tagged with a `pluginId` by the cloud router) and the runner's
// {@link InboundEvent} pipeline.
//
// The cloud forwards webhook frames over WS without parsing them
// (P4: cloud is provider-agnostic). On the runner side, this bridge
// resolves the matching plugin runtime, calls its `normalizeInbound`,
// and packages the resulting {@link NormalizedEvent} into an
// {@link InboundEvent} with `source: 'plugin'`.
//
// Lives in `plugins/` rather than `state/` because it depends on the
// PluginRegistry; the transport layer stays plugin-unaware and only
// references this through a callback.

import type { Logger } from 'pino'
import type { InboundEvent } from '@coro-ai/cloud-protocol'
import type { PluginRegistry } from './registry'
import type { ScmPluginRuntime, TrackerPluginRuntime } from './types'

export interface PluginWebhookNormalizerDeps {
  plugins: PluginRegistry
  logger: Logger
}

/**
 * Build a callback suitable for {@link WsTransportConfig.normalizePluginWebhook}.
 *
 * Returns `null` when the plugin isn't installed, the kind doesn't
 * support webhook normalisation, or `normalizeInbound` returns null
 * (plugin recognised the request as something it doesn't care
 * about — e.g. a ping). The transport drops the frame in that case.
 */
export function makePluginWebhookNormalizer(
  deps: PluginWebhookNormalizerDeps,
): (pluginId: string, headers: Record<string, string>, rawBody: Buffer) => InboundEvent | null {
  return (pluginId, headers, rawBody) => {
    const plugin = deps.plugins.byId(pluginId)
    if (!plugin) {
      deps.logger.warn({ pluginId }, 'Plugin webhook received for unknown pluginId')
      return null
    }

    // Only SCM and Tracker runtimes implement normalizeInbound today;
    // typescript-narrow them so the runtime check stays a single
    // branch.
    const normalize = (plugin as ScmPluginRuntime | TrackerPluginRuntime).normalizeInbound
    if (typeof normalize !== 'function') {
      deps.logger.debug({ pluginId, kind: plugin.manifest.kind }, 'Plugin does not support normalizeInbound — skipping')
      return null
    }

    const normalized = normalize.call(plugin, { headers, rawBody })
    if (!normalized) return null

    return {
      source: 'plugin',
      pluginId,
      eventKey: normalized.kind,
      ref: normalized.ref,
      payload: (normalized.raw ?? {}) as Record<string, unknown>,
      receivedAt: normalized.receivedAt,
    }
  }
}
