import { useState, type ReactNode } from 'react'
import { CheckCircle2, Loader2, PlugZap, XCircle } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'

export interface TestConnectionCheck {
  name: string
  ok: boolean
  message: string
  /** Optional remediation tip shown under failed checks. */
  hint?: string
}

export interface TestConnectionResult {
  ok: boolean
  /** Short message shown next to the button. Falls back to a default. */
  message?: string
  /**
   * Per-step breakdown. When present, the button renders a list of
   * checks (pass/fail with hints) so the user can see exactly which
   * part of the credential is wrong — not just "connection failed".
   */
  checks?: TestConnectionCheck[]
}

interface TestConnectionButtonProps {
  /** Async test fn; should return a result, never throw. */
  onTest: () => Promise<TestConnectionResult>
  disabled?: boolean
  label?: ReactNode
  className?: string
}

/**
 * Generic "verify this credential works" button. Calls a runner-side
 * test endpoint via the supplied callback; the runner is the one that
 * hits the third-party API (avoids dashboard CORS + secret leakage).
 *
 * When the result includes a `checks` array the button renders each
 * sub-check below the status line. This is essential for SCM
 * credentials where "connection ok" can mean five different things
 * (REST auth, workspace access, repo scope, git-over-HTTPS, reviewer
 * creds) — surfacing each one prevents the user from saving a config
 * that passes one check but breaks agents at the next.
 */
export default function TestConnectionButton({ onTest, disabled, label, className }: TestConnectionButtonProps) {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<TestConnectionResult | null>(null)

  async function run() {
    setRunning(true)
    setResult(null)
    try {
      const next = await onTest()
      setResult(next)
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className={cn('flex w-full flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void run()}
          disabled={disabled || running}
        >
          {running ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
          {running ? 'Testing…' : (label ?? 'Test connection')}
        </Button>
        {result ? (
          <div
            className={cn(
              'flex items-center gap-1.5 text-xs',
              result.ok ? 'text-success-300' : 'text-danger-300',
            )}
            role="status"
          >
            {result.ok ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
            <span>{result.message ?? (result.ok ? 'Connection succeeded.' : 'Connection failed.')}</span>
          </div>
        ) : null}
      </div>
      {result?.checks && result.checks.length > 0 ? (
        <ul className="space-y-1 rounded-xl border border-line bg-overlay/30 px-3 py-2 text-xs">
          {result.checks.map((c, i) => (
            <li key={`${c.name}-${i}`} className="flex items-start gap-2">
              {c.ok ? (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success-300" />
              ) : (
                <XCircle className="mt-0.5 size-3.5 shrink-0 text-danger-300" />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className={cn('font-medium', c.ok ? 'text-fg' : 'text-danger-300')}>{c.name}</span>
                  <span className="text-fg-subtle">{c.message}</span>
                </div>
                {!c.ok && c.hint ? (
                  <span className="text-fg-subtle italic">→ {c.hint}</span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
