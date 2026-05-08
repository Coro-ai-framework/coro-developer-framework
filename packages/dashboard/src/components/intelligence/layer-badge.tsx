import { Layers, Package, Server } from 'lucide-react'
import { cn } from '../../lib/utils'

// ── Layer Badge ─────────────────────────────────────────────────────────────
//
// Tiny chip that tells the developer which intelligence layer an artefact
// (workflow, agent, skill, memory file) came from. Provides a single
// vocabulary for provenance across every surface that renders intelligence:
//
//   • Coro   → ships with the runner, read-only (internally `base`)
//   • Custom → your overlay at ~/.coro/intelligence (writable, internally `tenant`)
//   • Repo   → the target repo's .coro/ folder (writable, repo-scoped)
//
// Optional `overrides` annotates that the displayed file is shadowing a
// lower-priority layer — e.g. a tenant workflow overriding the base one.

export type IntelligenceLayer = 'base' | 'tenant' | 'repo'

interface LayerBadgeProps {
  layer: IntelligenceLayer
  overrides?: IntelligenceLayer
  /** Compact form drops the icon & uses smaller padding. */
  size?: 'sm' | 'md'
  className?: string
}

const LAYER_META: Record<
  IntelligenceLayer,
  {
    label: string
    Icon: React.ComponentType<{ className?: string }>
    tone: string
    description: string
  }
> = {
  base: {
    label: 'Coro',
    Icon: Package,
    tone: 'bg-fg/8 text-fg-muted ring-line',
    description: 'Ships with the Coro runner. Read-only — override in your Custom or Repo layer.',
  },
  tenant: {
    label: 'Custom',
    Icon: Layers,
    tone: 'bg-accent-500/15 text-accent-200 ring-accent-500/30',
    description: 'Your custom overlay (~/.coro/intelligence). Edit here to apply across every repo.',
  },
  repo: {
    label: 'Repo',
    Icon: Server,
    tone: 'bg-success/15 text-success ring-success/30',
    description: "The target repo's .coro/ folder. Edit here for repo-local customisations.",
  },
}

export default function LayerBadge({ layer, overrides, size = 'md', className }: LayerBadgeProps) {
  const meta = LAYER_META[layer]
  const Icon = meta.Icon
  const title = overrides
    ? `${meta.description}\nOverrides ${LAYER_META[overrides].label.toLowerCase()} layer.`
    : meta.description
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-md font-medium uppercase tracking-wide ring-1',
        size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]',
        meta.tone,
        className,
      )}
    >
      <Icon className={size === 'sm' ? 'size-2.5' : 'size-3'} />
      {meta.label}
      {overrides ? (
        <span className="ml-0.5 normal-case text-[10px] opacity-70">
          ↳ overrides {LAYER_META[overrides].label.toLowerCase()}
        </span>
      ) : null}
    </span>
  )
}
