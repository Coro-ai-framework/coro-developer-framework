import { CheckCircle2, Circle } from 'lucide-react'
import { cn } from '../../../../lib/utils'
import ProviderLogo from '../../../../components/settings/ProviderLogo'

interface ProviderCardProps {
  pluginId: string
  title: string
  subtitle: string
  selected: boolean
  recommended?: boolean
  onSelect: () => void
}

/**
 * Selectable radio-style card with the provider's brand logo, name,
 * one-line subtitle, optional "Recommended" pill, and a selection
 * indicator on the right. Used everywhere the wizard asks the user
 * to pick exactly one provider.
 */
export default function ProviderCard({
  pluginId,
  title,
  subtitle,
  selected,
  recommended,
  onSelect,
}: ProviderCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'group relative flex w-full items-start gap-4 rounded-2xl border bg-overlay/30 px-4 py-4 text-left transition-all',
        'hover:bg-overlay/60 hover:border-accent-500/30',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60',
        selected
          ? 'border-accent-500/55 bg-accent-500/8 shadow-[0_0_0_1px_rgba(97,114,255,0.35),0_18px_40px_-30px_rgba(97,114,255,0.6)]'
          : 'border-line',
      )}
    >
      <span
        className={cn(
          'flex size-11 shrink-0 items-center justify-center rounded-xl ring-1 transition-colors',
          selected
            ? 'bg-accent-500/15 ring-accent-500/35'
            : 'bg-overlay/60 ring-line group-hover:bg-overlay group-hover:ring-line-strong',
        )}
      >
        <ProviderLogo pluginId={pluginId} size={22} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-medium text-fg">{title}</span>
          {recommended ? (
            <span className="inline-flex items-center rounded-full border border-accent-500/30 bg-accent-500/12 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-accent-200">
              Recommended
            </span>
          ) : null}
        </div>
        <div className="mt-1 text-[13px] leading-relaxed text-fg-muted">{subtitle}</div>
      </div>

      <span className="mt-0.5 shrink-0 text-fg-muted">
        {selected ? <CheckCircle2 className="size-5 text-accent-300" /> : <Circle className="size-5" />}
      </span>
    </button>
  )
}
