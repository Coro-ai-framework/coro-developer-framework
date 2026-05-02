import { useEffect, useState } from 'react'
import { ExternalLink, Eye, FileJson2, FileText, GitPullRequest, Link2 } from 'lucide-react'
import type { Artifact } from '../types'
import { formatDateTime } from '../lib/format'
import { requestText } from '../lib/http'
import { Badge } from './ui/badge'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { ScrollArea } from './ui/scroll-area'

interface ArtifactLinkProps {
  jobId: string
  artifact: Artifact
}

const contentCache = new Map<string, Promise<string> | string>()

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
          className="group flex items-start gap-3 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 transition-colors hover:border-indigo-400/30 hover:bg-white/[0.05]"
        >
          <div className="rounded-xl border border-white/8 bg-white/6 p-2.5 text-slate-200">{kindIcon(kind)}</div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="truncate text-sm font-medium text-white">{title}</div>
              <Badge variant="neutral" className="border-white/8 bg-white/5 text-slate-300">{kind}</Badge>
            </div>
            <div className="mt-1 truncate text-sm text-slate-400">{url}</div>
            <div className="mt-2 text-xs uppercase tracking-[0.14em] text-slate-500">Posted {formatDateTime(artifact.createdAt)}</div>
          </div>
          <ExternalLink className="mt-1 size-4 shrink-0 text-slate-500 group-hover:text-indigo-200" />
        </a>
      )
    }
  }

  if (typeof data['path'] === 'string' && (data['path'] as string).trim()) {
    return <FileArtefactButton jobId={jobId} artifact={artifact} />
  }

  return <JsonArtefactView artifact={artifact} />
}

function kindIcon(kind: string) {
  if (kind === 'pr-link') return <GitPullRequest className="size-4" />
  if (kind === 'url') return <Link2 className="size-4" />
  if (kind.endsWith('-md')) return <FileText className="size-4" />
  if (kind === 'analysis-contract') return <FileText className="size-4" />
  return <FileJson2 className="size-4" />
}

function FileArtefactButton({ jobId, artifact }: { jobId: string; artifact: Artifact }) {
  const [open, setOpen] = useState(false)
  const path = artifact.data['path'] as string

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full flex items-start gap-3 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 text-left transition-colors hover:border-indigo-400/30 hover:bg-white/[0.05]"
      >
        <div className="rounded-xl border border-white/8 bg-white/6 p-2.5 text-slate-200">{kindIcon(artifact.kind)}</div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="truncate text-sm font-medium text-white">{artifact.title}</div>
            <Badge variant="neutral" className="border-white/8 bg-white/5 text-slate-300">{artifact.kind}</Badge>
          </div>
          <div className="mt-1 truncate font-mono text-xs text-slate-500">{path}</div>
          <div className="mt-2 text-xs uppercase tracking-[0.14em] text-slate-500">Posted {formatDateTime(artifact.createdAt)}</div>
        </div>
        <Eye className="mt-1 size-4 shrink-0 text-slate-500" />
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
    const cacheKey = `${jobId}:${artifact.id}`
    const cached = contentCache.get(cacheKey)
    const request = typeof cached === 'string'
      ? Promise.resolve(cached)
      : cached ?? requestText(`/jobs/${jobId}/artifacts/${artifact.id}/content`)

    if (!contentCache.has(cacheKey)) {
      contentCache.set(cacheKey, request)
    }

    request
      .then(text => {
        contentCache.set(cacheKey, text)
        if (!cancelled) setContent(text)
      })
      .catch(err => {
        contentCache.delete(cacheKey)
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })

    return () => { cancelled = true }
  }, [jobId, artifact.id])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const path = artifact.data['path'] as string

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{artifact.title}</DialogTitle>
          <div className="space-y-1 text-sm text-slate-400">
            <div className="font-mono text-xs text-slate-500">{path}</div>
            <div>Posted {formatDateTime(artifact.createdAt)}</div>
          </div>
        </DialogHeader>
        <DialogBody>
          {error ? (
            <div className="rounded-2xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
              Could not load artifact: {error}
            </div>
          ) : !content ? (
            <div className="text-sm text-slate-500 animate-pulse">Loading artifact content…</div>
          ) : (
            <ScrollArea className="h-[60vh] rounded-2xl border border-white/8 bg-slate-950/70">
              <div className="p-5">
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6 text-slate-100">
                  {content}
                </pre>
              </div>
            </ScrollArea>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function JsonArtefactView({ artifact }: { artifact: Artifact }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="rounded-lg border border-zinc-800 overflow-hidden bg-zinc-900">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/[0.04] transition-colors text-left bg-white/[0.03]"
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="rounded-xl border border-white/8 bg-white/6 p-2 text-slate-200">{kindIcon(artifact.kind)}</div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-white truncate">{artifact.title}</div>
            <div className="text-[11px] text-slate-500 uppercase tracking-[0.14em]">{artifact.kind}</div>
          </div>
        </div>
        <svg
          className={`w-4 h-4 text-slate-500 transition-transform shrink-0 ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <pre className="max-h-80 overflow-y-auto overflow-x-auto border-t border-white/8 bg-slate-950/70 p-4 text-xs font-mono text-slate-200 whitespace-pre-wrap break-words">
          {JSON.stringify(artifact.data, null, 2)}
        </pre>
      )}
    </div>
  )
}
