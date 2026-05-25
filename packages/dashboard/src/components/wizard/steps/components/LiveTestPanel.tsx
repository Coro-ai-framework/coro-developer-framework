import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { cn } from '../../../../lib/utils'
import type { StepStatus, TestResult } from '../../wizard-state'

interface LiveTestPanelProps {
  status: StepStatus
  result: TestResult | null
}

/**
 * Renders the inline outcome of the per-step "Test & Continue" call.
 * Shows nothing in `idle` state, a spinner while testing, a green
 * success notice on pass, and a structured error block with the
 * server-supplied hint + per-check breakdown on failure.
 */
export default function LiveTestPanel({ status, result }: LiveTestPanelProps) {
  if (status === 'idle' || status === 'skipped') return null

  if (status === 'testing') {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-line bg-overlay/40 px-3 py-2.5 text-sm text-fg-muted">
        <Loader2 className="size-4 shrink-0 animate-spin text-accent-300" />
        <span>Probing the provider…</span>
      </div>
    )
  }

  if (!result) return null

  if (status === 'passed') {
    return (
      <div className="flex items-start gap-2.5 rounded-xl border border-success-500/30 bg-success-500/8 px-3 py-2.5 text-sm text-success-300">
        <CheckCircle2 className="size-4 shrink-0 translate-y-0.5" />
        <div className="space-y-1">
          <div className="font-medium text-fg">Credentials verified</div>
          <div className="text-fg-muted">{result.message}</div>
        </div>
      </div>
    )
  }

  // status === 'failed'
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2.5 rounded-xl border border-danger-500/35 bg-danger-500/8 px-3 py-2.5 text-sm">
        <XCircle className="size-4 shrink-0 translate-y-0.5 text-danger-400" />
        <div className="space-y-1">
          <div className="font-medium text-fg">Test failed</div>
          <div className="text-fg-muted">{result.message}</div>
          {result.hint ? (
            <div className="flex items-start gap-1.5 pt-1 text-[12px] text-fg-subtle">
              <AlertTriangle className="size-3.5 shrink-0 translate-y-0.5 text-warning-400" />
              <span>{result.hint}</span>
            </div>
          ) : null}
        </div>
      </div>

      {result.checks && result.checks.length > 0 ? (
        <ul className="space-y-1 rounded-xl border border-line bg-overlay/30 px-3 py-2.5">
          {result.checks.map((c, i) => (
            <li key={`${c.name}-${i}`} className="flex items-start gap-2 text-[12px]">
              <span
                className={cn(
                  'mt-0.5 inline-flex size-3.5 shrink-0 items-center justify-center rounded-full',
                  c.ok
                    ? 'bg-success-500/15 text-success-300'
                    : 'bg-danger-500/15 text-danger-300',
                )}
              >
                {c.ok ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
              </span>
              <div className="min-w-0">
                <div className="font-medium text-fg">{c.name}</div>
                <div className="text-fg-muted">{c.message}</div>
                {c.hint ? <div className="mt-0.5 text-fg-subtle">{c.hint}</div> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
