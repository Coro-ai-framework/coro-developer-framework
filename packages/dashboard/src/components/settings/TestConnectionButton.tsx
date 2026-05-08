import { useState, type ReactNode } from 'react'
import { CheckCircle2, Loader2, PlugZap, XCircle } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'

export interface TestConnectionResult {
  ok: boolean
  /** Short message shown next to the button. Falls back to a default. */
  message?: string
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
    <div className={cn('flex flex-wrap items-center gap-3', className)}>
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
  )
}
