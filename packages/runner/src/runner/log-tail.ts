/**
 * Where a log replay should start.
 *
 * `GET /jobs/:jobId/stream` replays the whole log before it tails, which is
 * what the job page's console wants and the opposite of what a surface
 * showing one line wants (the intake chat's active-run card). `?tail=N`
 * asks for the last N lines instead. Absent or unparseable means "all",
 * so existing clients are unaffected.
 */
export function resolveLogReplayStart(totalLines: number, tailParam: unknown): number {
  const raw = Array.isArray(tailParam) ? tailParam[0] : tailParam
  const tail = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : Number.NaN
  if (!Number.isFinite(tail) || tail <= 0) return 0
  return Math.max(0, totalLines - Math.floor(tail))
}
