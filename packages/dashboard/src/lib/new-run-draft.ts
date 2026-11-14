/** A fresh plan-mode conversation id. */
export function mintSessionId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `intake-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
