/**
 * Vendor constants for the Jev decision plugin.
 *
 * Imported by config resolution so a missing key can still fall back to this
 * provider's legacy env var. The HTTP client is not imported from here — the
 * runner loads that only when this provider is actually selected.
 */
export const JEV_PROVIDER_ID = 'jev'
export const JEV_DEFAULT_MODEL = 'jev-1.13.0'
export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai'
/** Honoured only when `CORO_DECISION_API_KEY` is unset. */
export const JEV_LEGACY_API_KEY_ENV = 'TYPESAFE_API_KEY'
