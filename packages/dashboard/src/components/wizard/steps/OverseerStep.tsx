import { CheckCircle2, Circle, Eye, ShieldCheck } from 'lucide-react'
import Field from '../../forms/field'
import SecretInput from '../../settings/SecretInput'
import { cn } from '../../../lib/utils'
import { MANAGE_SUMMARY, OBSERVE_SUMMARY } from '../../../lib/decision-mode'
import StepShell from './components/StepShell'
import type { OverseerWizardState } from '../wizard-state'

interface OverseerStepProps {
  state: OverseerWizardState
  configured: boolean
  onKey: (apiKey: string) => void
  onMode: (mode: 'shadow' | 'live') => void
}

const MODES = [
  {
    id: 'shadow' as const,
    title: 'Observe',
    badge: 'Recommended',
    body: OBSERVE_SUMMARY,
    icon: Eye,
  },
  {
    id: 'live' as const,
    title: 'Manage',
    badge: null,
    body: MANAGE_SUMMARY,
    icon: ShieldCheck,
  },
]

export default function OverseerStep({ state, configured, onKey, onMode }: OverseerStepProps) {
  return (
    <StepShell
      eyebrow="Optional"
      title="Keep the job faithful"
      description="Jev plus Coro is Overseer. It watches each phase and says whether the run is still doing what you asked. It does not write the code. Coro is complete without it — a key only makes the on-track mark possible."
    >
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-overlay/40 px-4 py-3">
        <FormulaChip>Jev</FormulaChip>
        <span className="text-sm text-fg-subtle">+</span>
        <FormulaChip>Coro</FormulaChip>
        <span className="text-sm text-fg-subtle">=</span>
        <FormulaChip accent>Overseer</FormulaChip>
        <span className="ml-1 text-[13px] text-fg-muted">a faithfulness check on the running job</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {MODES.map(mode => {
          const selected = state.mode === mode.id
          const Icon = mode.icon
          return (
            <button
              key={mode.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onMode(mode.id)}
              className={cn(
                'flex items-start gap-3 rounded-2xl border px-4 py-3.5 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60',
                selected
                  ? 'border-accent-500/55 bg-accent-500/8'
                  : 'border-line bg-overlay/30 hover:border-accent-500/30 hover:bg-overlay/60',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg ring-1',
                  selected ? 'bg-accent-500/15 text-accent-200 ring-accent-500/35' : 'bg-overlay/60 text-fg-muted ring-line',
                )}
              >
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-fg">{mode.title}</span>
                  {mode.badge ? (
                    <span className="rounded-full border border-accent-500/30 bg-accent-500/12 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-accent-200">
                      {mode.badge}
                    </span>
                  ) : null}
                </span>
                <span className="mt-1 block text-[13px] leading-relaxed text-fg-muted">{mode.body}</span>
              </span>
              {selected ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-accent-300" />
              ) : (
                <Circle className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
              )}
            </button>
          )
        })}
      </div>

      <Field
        label="Jev API key"
        hint={
          configured
            ? 'A key is already saved. Leave this blank to keep it, or paste a new one.'
            : 'Only if you have one. No key means Overseer stays off and Coro never calls Jev.'
        }
      >
        <SecretInput
          value={state.apiKey}
          onChange={event => onKey(event.target.value)}
          placeholder={configured ? 'saved key stays in place' : 'paste a key to turn Overseer on'}
        />
      </Field>
    </StepShell>
  )
}

function FormulaChip({ children, accent = false }: { children: string; accent?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-1 text-[12px] font-medium',
        accent
          ? 'border-accent-500/35 bg-accent-500/12 text-accent-200'
          : 'border-line-strong bg-canvas/50 text-fg',
      )}
    >
      {children}
    </span>
  )
}
