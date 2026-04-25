// ── Tenant overlay loader: cloudBlob (Phase 5 stub) ──────────────────────────
//
// Source variant:  { kind: 'cloudBlob', key: string }
//
// Used in hybrid (cloud SaaS) deployments where the cloud control plane
// stores tenant overlays in object storage and serves them to runners
// over the authenticated WebSocket. The full implementation requires:
//   - Cloud-side overlay upload + diffing API
//   - Runner-side WebSocket request/response framing for blob fetch
//   - Local cache + ETag/version validation
//
// All of that is Phase 5 territory. For now this loader is a typed stub
// that warns and returns null so the resolver gracefully degrades to
// `base + repo` if a tenant declares a cloudBlob source today.

import type { Logger } from 'pino'

export interface CloudBlobLoaderArgs {
  key: string
  tenantId: string
  logger: Logger
}

export async function loadCloudBlobOverlay(
  args: CloudBlobLoaderArgs,
): Promise<string | null> {
  const { key, tenantId, logger } = args
  logger.warn(
    { tenantId, key },
    'cloudBlob tenant overlay loader is not implemented yet (Phase 5) — skipping layer',
  )
  return null
}
