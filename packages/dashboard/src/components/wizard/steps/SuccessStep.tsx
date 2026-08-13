import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowRight, Bot, CheckCircle2, FileStack, GitBranch, KanbanSquare, Layers, PlayCircle, Settings2, Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '../../ui/button'
import { Switch } from '../../ui/switch'
import { cn } from '../../../lib/utils'
import { jsonRequest, requestJson } from '../../../lib/http'
import type { WizardState } from '../wizard-state'
import { hasSkippedRequiredStep } from '../wizard-state'

interface SuccessStepProps {
  wizardState: WizardState
  onFinish: (target: 'newJob' | 'dashboard' | 'settings') => void
}

const STATUS_PILL = {
  passed: {
    icon: CheckCircle2,
    classes: 'border-success-500/30 bg-success-500/10 text-success-300',
    label: 'Verified',
  },
  skipped: {
    icon: AlertTriangle,
    classes: 'border-warning-500/30 bg-warning-500/10 text-warning-300',
    label: 'Skipped',
  },
  failed: {
    icon: AlertTriangle,
    classes: 'border-danger-500/30 bg-danger-500/10 text-danger-300',
    label: 'Failed',
  },
  idle: {
    icon: AlertTriangle,
    classes: 'border-line bg-overlay/60 text-fg-subtle',
    label: 'Not configured',
  },
  testing: {
    icon: AlertTriangle,
    classes: 'border-line bg-overlay/60 text-fg-subtle',
    label: 'Pending',
  },
} as const

/**
 * Final step. Recaps what was configured (and what was skipped),
 * gives the user a short Coro explainer so they leave with a mental
 * model, and points them at "Create my first job".
 */
export default function SuccessStep({ wizardState, onFinish }: SuccessStepProps) {
  const skippedRequired = hasSkippedRequiredStep(wizardState)
  const [mcpDiscovered, setMcpDiscovered] = useState<{ count: number; ids: string[] } | null>(null)
  const [inheritMcps, setInheritMcps] = useState(false)

  useEffect(() => {
    void requestJson<{ count: number; ids: string[] }>('/config/mcp/discovered')
      .then(setMcpDiscovered)
      .catch(() => setMcpDiscovered(null))
  }, [])

  async function toggleInheritMcps(enabled: boolean) {
    setInheritMcps(enabled)
    await requestJson('/config', jsonRequest({ inheritClaudeCodeMcps: enabled }, { method: 'PUT' }))
  }

  const rows = [
    { id: 'llm' as const, icon: Bot, label: 'LLM provider' },
    { id: 'scm' as const, icon: GitBranch, label: 'Code host' },
    { id: 'tracker' as const, icon: KanbanSquare, label: 'Issue tracker (optional)' },
  ]

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="inline-flex items-center gap-1.5 rounded-full border border-success-500/30 bg-success-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-success-300">
          <Sparkles className="size-3.5" />
          Setup complete
        </div>
        <h2 className="text-balance text-2xl font-semibold tracking-tight text-fg">
          {skippedRequired ? "You're almost there" : "You're ready to run your first job"}
        </h2>
        <p className="max-w-2xl text-pretty text-sm text-fg-muted">
          {skippedRequired
            ? 'You can finish later from Settings. Until then, jobs that need the skipped piece will fail at dispatch.'
            : 'Here is a quick recap. Below is how Coro works at a glance so you know what to do next.'}
        </p>
      </div>

      {/* ── Configured summary ─────────────────────────────────────── */}
      <div className="space-y-2">
        {rows.map(row => {
          const step = wizardState.steps[row.id]
          const pill = STATUS_PILL[step.status]
          const PillIcon = pill.icon
          const Icon = row.icon
          return (
            <div
              key={row.id}
              className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-overlay/40 px-4 py-3.5"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="inline-flex size-9 items-center justify-center rounded-xl bg-overlay/60 ring-1 ring-line text-fg-muted">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-fg">{row.label}</div>
                  <div className="truncate text-[12px] text-fg-muted">
                    {step.selectedProviderId && step.selectedProviderId !== '__skip__'
                      ? step.selectedProviderId
                      : 'Not configured'}
                  </div>
                </div>
              </div>
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.14em]',
                  pill.classes,
                )}
              >
                <PillIcon className="size-3.5" />
                {pill.label}
              </span>
            </div>
          )
        })}
      </div>

      {mcpDiscovered && mcpDiscovered.count > 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-overlay/40 px-4 py-3.5">
          <div className="min-w-0">
            <div className="text-sm font-medium text-fg">
              Reuse {mcpDiscovered.count} MCP server{mcpDiscovered.count === 1 ? '' : 's'} from Claude Code
            </div>
            <div className="text-[12px] text-fg-muted truncate">
              {mcpDiscovered.ids.join(', ')}
            </div>
          </div>
          <Switch checked={inheritMcps} onCheckedChange={v => void toggleInheritMcps(v)} />
        </div>
      ) : null}

      {/* ── How Coro works (mini explainer) ───────────────────────── */}
      <div className="space-y-3 rounded-2xl border border-line bg-overlay/30 p-5">
        <div className="text-sm font-semibold text-fg">How Coro works</div>
        <div className="grid gap-4 sm:grid-cols-3">
          <ExplainerCard
            icon={PlayCircle}
            title="Jobs and workflows"
            body="Coro runs each job through a workflow of phases — plan, code, review, evaluate. Every phase is an LLM agent with the right tools and skills."
          />
          <ExplainerCard
            icon={Layers}
            title="Layered intelligence"
            body="Out of the box you get the base intelligence. Add tenant- and repo-specific knowledge later from Settings → Intelligence."
          />
          <ExplainerCard
            icon={FileStack}
            title="Watch and steer"
            body="Open the dashboard for live logs, proposed PRs, and approvals. You're always one click away from steering or pausing a run."
          />
        </div>
      </div>

      {/* ── Primary CTA ────────────────────────────────────────────── */}
      {skippedRequired ? (
        <div className="rounded-2xl border border-warning-500/30 bg-warning-500/8 p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="size-5 shrink-0 text-warning-400" />
            <div className="space-y-3">
              <div className="text-sm font-medium text-fg">Finish the required setup to run jobs</div>
              <p className="text-sm text-fg-muted">
                Jobs need an LLM and a code host to do their work. Finish the steps you skipped in Settings, then come back to dispatch your first job.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button asChild>
                  <Link to="/settings" onClick={() => onFinish('settings')}>
                    <Settings2 />
                    Finish setup in Settings
                    <ArrowRight />
                  </Link>
                </Button>
                <Button asChild variant="ghost" onClick={() => onFinish('dashboard')}>
                  <Link to="/">Go to dashboard</Link>
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button asChild variant="ghost" onClick={() => onFinish('dashboard')}>
            <Link to="/">Go to dashboard</Link>
          </Button>
          <Button asChild onClick={() => onFinish('newJob')}>
            <Link to="/jobs/new">
              <PlayCircle />
              Create my first job
              <ArrowRight />
            </Link>
          </Button>
        </div>
      )}
    </div>
  )
}

function ExplainerCard({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof PlayCircle
  title: string
  body: string
}) {
  return (
    <div className="space-y-2 rounded-xl border border-line bg-canvas/40 p-3.5">
      <span className="inline-flex size-8 items-center justify-center rounded-lg bg-accent-500/12 ring-1 ring-accent-500/25 text-accent-200">
        <Icon className="size-4" />
      </span>
      <div className="text-sm font-medium text-fg">{title}</div>
      <div className="text-[12px] leading-relaxed text-fg-muted">{body}</div>
    </div>
  )
}
