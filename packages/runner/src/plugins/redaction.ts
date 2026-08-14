// ── Secret redaction round-trip ──────────────────────────────────────────────
//
// The dashboard must be able to show that a credential is set without ever
// receiving it. `GET /config` masks every secret-shaped field; the dashboard
// echoes the mask back on save and on "Test connection"; the runner swaps the
// mask for the real on-disk value before persisting or probing.
//
// This module is the single definition of that contract. It used to be
// duplicated — `server.ts` emitted and matched `...` while `plugin-probe.ts`
// matched a lone `…` — so `POST /test/plugin/:id` treated a masked token as a
// literal credential and probed with garbage. Anything that participates in
// the round trip must import from here.

/** Separator embedded in a masked secret (`ghp_abcdefghijkl...wxyz`). */
export const REDACTION_PLACEHOLDER = '...'

/**
 * Older builds masked secrets as a lone ellipsis. Still accepted on the way
 * in so a dashboard served from a stale cache can't write a placeholder into
 * a config field.
 */
const LEGACY_REDACTION_PLACEHOLDER = '…'

/**
 * Shape of a value produced by {@link redactSecret}: a short prefix, the
 * separator, a short suffix, no whitespace. Matching the shape rather than
 * merely containing `...` matters because
 * {@link mergeWithRedactionFill} applies to every key, not just
 * secret-shaped ones — a prose or URL field that happens to contain an
 * ellipsis must not be mistaken for a masked credential.
 */
const REDACTED_SHAPE = /^\S{1,16}\.\.\.\S{1,8}$/

/** Mask a secret for display: enough prefix/suffix to recognise it, hide the middle. */
export function redactSecret(value: string | undefined | null): string {
  if (!value) return ''
  if (value.length <= 16) {
    return `${value.slice(0, 2)}${REDACTION_PLACEHOLDER}${value.slice(-2)}`
  }
  return `${value.slice(0, 12)}${REDACTION_PLACEHOLDER}${value.slice(-4)}`
}

/** Is this value a mask the dashboard echoed back, rather than a real credential? */
export function isRedacted(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed === LEGACY_REDACTION_PLACEHOLDER) return true
  return REDACTED_SHAPE.test(trimmed)
}

/**
 * Heuristic: does a plugin-config field name look like a secret?
 *
 * Plugin manifests (`PluginManifest.configSchema`) use arbitrary field names —
 * there is no "this is a secret" annotation in the schema today. Rather than
 * force every plugin to declare a secret list, we redact based on common
 * naming conventions. Best-effort: prefer to rotate tokens that ever leaked
 * through the dashboard.
 */
export function isSecretFieldName(name: string): boolean {
  return /token|apikey|api_key|password|secret|appPassword/i.test(name)
}

/**
 * Walk a plugin-config object and mask every secret-shaped field. Used by
 * `GET /config` so the dashboard can hint that a value is set without ever
 * shipping the real credential to the browser.
 */
export function redactPluginConfig(
  cfg: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!cfg) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(cfg)) {
    out[k] = typeof v === 'string' && isSecretFieldName(k) ? redactSecret(v) : v
  }
  return out
}

/**
 * Per-key merge for the save path: incoming values win, except a masked
 * secret, which leaves the on-disk value untouched.
 */
export function mergePluginConfig(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const prev = existing ?? {}
  if (!incoming) return { ...prev }
  const out: Record<string, unknown> = { ...prev }
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined) continue
    if (isSecretFieldName(k) && isRedacted(v)) continue
    out[k] = v
  }
  return out
}

/**
 * Deep merge for the probe path: the draft the dashboard is testing, laid
 * over the on-disk config, with masked values replaced by the real ones so
 * the plugin always receives a credential it can actually authenticate with.
 */
export function mergeWithRedactionFill(
  onDisk: Record<string, unknown>,
  draft: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...onDisk }
  for (const [key, draftValue] of Object.entries(draft)) {
    const diskValue = onDisk[key]
    if (isRedacted(draftValue)) {
      if (diskValue !== undefined) out[key] = diskValue
      continue
    }
    if (
      draftValue !== null
      && typeof draftValue === 'object'
      && !Array.isArray(draftValue)
      && diskValue !== null
      && typeof diskValue === 'object'
      && !Array.isArray(diskValue)
    ) {
      out[key] = mergeWithRedactionFill(
        diskValue as Record<string, unknown>,
        draftValue as Record<string, unknown>,
      )
      continue
    }
    out[key] = draftValue
  }
  return out
}
