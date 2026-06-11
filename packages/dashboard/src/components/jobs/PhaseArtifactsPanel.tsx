import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Artifact } from '../../types'
import ArtifactLink from '../ArtifactLink'
import { cn } from '../../lib/utils'

interface PhaseArtifactsPanelProps {
  jobId: string
  artifacts: Artifact[]
  phaseName: string
}

export default function PhaseArtifactsPanel({
  jobId,
  artifacts,
  phaseName,
}: PhaseArtifactsPanelProps) {
  const [open, setOpen] = useState(false)
  const count = artifacts.length

  const summary =
    count === 0
      ? 'No artifacts yet'
      : `${count} artifact${count === 1 ? '' : 's'}`

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-canvas/20">
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-overlay/50"
      >
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
            Phase artifacts
          </div>
          <div className="truncate text-[13px] text-fg-muted">
            {summary}
            {count > 0 && !open ? (
              <span className="text-fg-subtle">
                {' '}
                · {artifacts.map(artifact => artifact.title).join(', ')}
              </span>
            ) : null}
          </div>
        </div>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-fg-subtle transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open ? (
        <div className="border-t border-line">
          {count === 0 ? (
            <div className="px-3 py-2.5 text-[13px] text-fg-subtle">
              No artifacts have been posted for <span className="font-mono">{phaseName}</span> yet.
            </div>
          ) : (
            <div className="max-h-[min(280px,40vh)] divide-y divide-line overflow-y-auto">
              {artifacts.map(artifact => (
                <ArtifactLink
                  key={artifact.id}
                  jobId={jobId}
                  artifact={artifact}
                  variant="compact"
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
