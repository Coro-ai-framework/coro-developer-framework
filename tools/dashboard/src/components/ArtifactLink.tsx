import { useEffect, useState } from 'react'
import type { Artifact } from '../types'

interface ArtifactLinkProps {
  jobId: string
  artifact: Artifact
}

/**
 * Renders a single artefact entry. The `kind` drives how it is displayed:
 *
 *   - `pr-link` / `url`  → external link
 *   - `plan-md`, `report-md`, `evaluation-md`, `analysis-contract`, and any
 *                          other kind whose `data.path` is set → opens a modal
 *                          that fetches file contents from the server
 *   - anything else      → collapsible JSON blob
 *
 * Unknown kinds still render (fallback JSON), so agents posting a new kind
 * never silently break the dashboard.
 */
export default function ArtifactLink({ jobId, artifact }: ArtifactLinkProps) {
  const { kind, title, data } = artifact

  if (kind === 'pr-link' || kind === 'url') {
    const url = data['url'] as string | undefined
    if (url) {
      return (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-indigo-700 transition-colors text-left"
        >
          <span className="text-sm">{kindEmoji(kind)}</span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-zinc-100 truncate">{title}</div>
            <div className="text-xs text-indigo-300 truncate">{url}</div>
          </div>
          <svg className="w-3.5 h-3.5 text-zinc-500 group-hover:text-indigo-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
        </a>
      )
    }
  }

  if (typeof data['path'] === 'string' && (data['path'] as string).trim()) {
    return <FileArtefactButton jobId={jobId} artifact={artifact} />
  }

  return <JsonArtefactView artifact={artifact} />
}

function kindEmoji(kind: string): string {
  if (kind === 'pr-link') return '🔗'
  if (kind === 'url') return '🔗'
  if (kind.endsWith('-md')) return '📄'
  if (kind === 'test-results') return '✅'
  if (kind === 'analysis-contract') return '📐'
  if (kind === 'approval') return '👍'
  return '📦'
}

function FileArtefactButton({ jobId, artifact }: { jobId: string; artifact: Artifact }) {
  const [open, setOpen] = useState(false)
  const path = artifact.data['path'] as string

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-indigo-700 transition-colors text-left"
      >
        <span className="text-sm">{kindEmoji(artifact.kind)}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-zinc-100 truncate">{artifact.title}</div>
          <div className="text-xs text-zinc-500 truncate font-mono">{path}</div>
        </div>
        <svg className="w-3.5 h-3.5 text-zinc-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </svg>
      </button>

      {open && <ArtefactModal jobId={jobId} artifact={artifact} onClose={() => setOpen(false)} />}
    </>
  )
}

function ArtefactModal({
  jobId,
  artifact,
  onClose,
}: {
  jobId: string
  artifact: Artifact
  onClose: () => void
}) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/jobs/${jobId}/artifacts/${artifact.id}/content`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      .then(text => { if (!cancelled) setContent(text) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [jobId, artifact.id])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const path = artifact.data['path'] as string

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="bg-zinc-950 border border-zinc-800 rounded-xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-zinc-100 truncate">{artifact.title}</div>
            <div className="text-xs text-zinc-500 truncate font-mono">{path}</div>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 transition-colors shrink-0 ml-4"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {error && (
            <div className="p-3 rounded-lg bg-rose-950/30 border border-rose-800 text-rose-300 text-sm">
              Could not load artefact: {error}
            </div>
          )}
          {!error && content === null && (
            <div className="text-xs text-zinc-500 animate-pulse">Loading…</div>
          )}
          {!error && content !== null && (
            <pre className="text-xs font-mono text-zinc-200 whitespace-pre-wrap break-words">
              {content}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}

function JsonArtefactView({ artifact }: { artifact: Artifact }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="rounded-lg border border-zinc-800 overflow-hidden bg-zinc-900">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-zinc-800/80 transition-colors text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm">{kindEmoji(artifact.kind)}</span>
          <div className="min-w-0">
            <div className="text-sm font-medium text-zinc-100 truncate">{artifact.title}</div>
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider">{artifact.kind}</div>
          </div>
        </div>
        <svg
          className={`w-4 h-4 text-zinc-500 transition-transform shrink-0 ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <pre className="p-3 text-xs font-mono text-zinc-300 bg-zinc-950 overflow-x-auto max-h-72 overflow-y-auto whitespace-pre-wrap break-words">
          {JSON.stringify(artifact.data, null, 2)}
        </pre>
      )}
    </div>
  )
}
