import { AlertCircle, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'

export interface PreflightResult {
  kind?: string
  ok: boolean
  errors: string[]
  warnings: string[]
}

interface PreflightPanelProps {
  preflight: PreflightResult | null
  loading: boolean
}

export default function PreflightPanel({ preflight, loading }: PreflightPanelProps) {
  if (loading && !preflight) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-fg-subtle">
        <Loader2 className="size-3 animate-spin" /> Validating…
      </div>
    )
  }
  if (!preflight) return null
  return (
    <div
      className={`space-y-1 rounded-md border px-3 py-2 text-[12px] ${
        preflight.ok
          ? 'border-success-500/40 bg-success-500/10'
          : 'border-danger-500/40 bg-danger-500/10'
      }`}
    >
      <div className="flex items-center gap-1.5 font-medium">
        {preflight.ok ? (
          <CheckCircle2 className="size-3.5 text-success-400" />
        ) : (
          <AlertCircle className="size-3.5 text-danger-400" />
        )}
        {preflight.ok ? 'Ready to save' : 'Validation errors'}
      </div>
      {preflight.errors.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5 text-danger-400">
          {preflight.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      ) : null}
      {preflight.warnings.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5 text-warning">
          {preflight.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-1">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
