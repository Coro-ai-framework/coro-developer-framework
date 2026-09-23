import { useState } from 'react'
import { ChevronDown, ExternalLink } from 'lucide-react'
import type { Artifact } from '../../types'
import { ArtifactPreviewModal } from '../ArtifactLink'
import { ArtifactKindIcon } from './artifact-presentation'
import {
  artifactCategory,
  artifactCategoryLabel,
  artifactExternalUrl,
  documentArtifacts,
} from '../../lib/job-detail-presentation'
import { cn } from '../../lib/utils'

interface PhaseArtifactShelfProps {
  jobId: string
  artifacts: Artifact[]
}

const ROW =
  'group flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60'

function accessibleName(artifact: Artifact): string {
  const edited = artifact.editedAt ? ', edited' : ''
  return `${artifact.title}, ${artifact.kind}${edited}`
}

export default function PhaseArtifactShelf({ jobId, artifacts }: PhaseArtifactShelfProps) {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<Artifact | null>(null)
  const documents = documentArtifacts(artifacts)

  return (
    <>
      <div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(current => !current)}
          className="flex w-full items-center justify-between gap-3 rounded-lg py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60"
        >
          <span className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
            Artifacts
            <span className="ml-1.5 tabular-nums normal-case tracking-normal text-fg-muted">{documents.length}</span>
          </span>
          <ChevronDown
            className={cn('size-3.5 shrink-0 text-fg-subtle transition-transform', open && 'rotate-180')}
            aria-hidden
          />
        </button>
        {open && documents.length === 0 ? (
          <p className="px-2 py-1.5 text-[12px] text-fg-subtle">No artifacts yet.</p>
        ) : null}
        {open && documents.length > 0 ? (
        <ul
          className="mt-1 max-h-56 list-none space-y-0.5 overflow-y-auto pr-1"
          aria-label="Artifacts"
        >
          {documents.map(artifact => {
            const url = artifactExternalUrl(artifact)
            const category = artifactCategoryLabel(artifactCategory(artifact.kind))
            const body = (
              <>
                <ArtifactKindIcon kind={artifact.kind} className="size-3.5 shrink-0 text-fg-muted group-hover:text-fg" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-fg" title={artifact.title}>
                  {artifact.title}
                </span>
                <span className="hidden shrink-0 font-mono text-[10px] text-fg-subtle sm:inline">
                  {artifact.phase}
                </span>
                <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-fg-subtle">
                  {category}
                </span>
                {artifact.editedAt ? (
                  <span className="size-1.5 shrink-0 rounded-full bg-warning-400" title="Edited" />
                ) : null}
                {url ? <ExternalLink className="size-3 shrink-0 text-fg-subtle" aria-hidden /> : null}
              </>
            )

            if (url) {
              return (
                <li key={artifact.id}>
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={ROW}
                    aria-label={accessibleName(artifact)}
                    title={artifact.title}
                  >
                    {body}
                  </a>
                </li>
              )
            }

            return (
              <li key={artifact.id}>
                <button
                  type="button"
                  onClick={() => setPreview(artifact)}
                  className={cn(ROW, 'cursor-pointer')}
                  aria-label={accessibleName(artifact)}
                  title={artifact.title}
                >
                  {body}
                </button>
              </li>
            )
          })}
        </ul>
        ) : null}
      </div>

      {preview ? (
        <ArtifactPreviewModal
          jobId={jobId}
          artifact={preview}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </>
  )
}
