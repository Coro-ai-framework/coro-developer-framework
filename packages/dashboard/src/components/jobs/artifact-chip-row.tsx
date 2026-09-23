import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { Artifact } from '../../types'
import { ArtifactPreviewModal } from '../ArtifactLink'
import { ArtifactKindIcon } from './artifact-presentation'
import { artifactExternalUrl, artifactFileLabel, isPullRequestArtifact } from '../../lib/job-detail-presentation'
import { cn } from '../../lib/utils'

interface ArtifactChipRowProps {
  jobId: string
  artifacts: Artifact[]
  className?: string
}

const CHIP =
  'inline-flex max-w-[190px] shrink-0 items-center gap-1.5 rounded-lg border border-line bg-overlay/40 px-2 py-1 text-[11px] text-fg-muted transition-colors hover:border-accent-500/35 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60'

/**
 * Every artefact a run has posted, as one scrollable row of files. Click
 * behaviour is the job page's: links open in a tab, everything else opens
 * the shared artefact viewer.
 */
export default function ArtifactChipRow({ jobId, artifacts, className }: ArtifactChipRowProps) {
  const [preview, setPreview] = useState<Artifact | null>(null)
  if (artifacts.length === 0) return null

  return (
    <>
      <div
        className={cn(
          'flex items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          className,
        )}
      >
        <span className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
          {artifacts.length} file{artifacts.length === 1 ? '' : 's'}
        </span>
        {artifacts.map(artifact => {
          const url = isPullRequestArtifact(artifact.kind)
            ? (typeof artifact.data['url'] === 'string' && artifact.data['url'].trim()
              ? artifact.data['url'].trim()
              : null)
            : artifactExternalUrl(artifact)
          if (isPullRequestArtifact(artifact.kind) && !url) return null
          const label = artifactFileLabel(artifact)

          if (url) {
            return (
              <a
                key={artifact.id}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className={CHIP}
                title={`${artifact.title} — ${url}`}
              >
                <ArtifactKindIcon kind={artifact.kind} className="size-3 shrink-0" />
                <span className="truncate">{label}</span>
                <ExternalLink className="size-3 shrink-0 opacity-60" />
              </a>
            )
          }

          return (
            <button
              key={artifact.id}
              type="button"
              onClick={() => setPreview(artifact)}
              className={CHIP}
              title={`${artifact.title} (${artifact.kind})`}
            >
              <ArtifactKindIcon kind={artifact.kind} className="size-3 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          )
        })}
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
