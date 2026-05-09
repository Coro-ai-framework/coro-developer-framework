import { useEffect, useState } from 'react'
import { ChevronDown, ExternalLink, Eye, FileJson2, FileText, GitPullRequest, Link2 } from 'lucide-react'
import type { Artifact } from '../types'
import { formatDateTime } from '../lib/format'
import { requestText } from '../lib/http'
import { Badge } from './ui/badge'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { ScrollArea } from './ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import { renderInlineMarkdown } from './intelligence/markdown-mini'
import ErrorState from './common/error-state'
import { cn } from '../lib/utils'

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
          className="group flex items-start gap-3 rounded-2xl border border-line bg-overlay/40 px-4 py-3 transition-colors hover:border-accent-500/30 hover:bg-overlay/60"
        >
          <ArtifactIcon kind={kind} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="truncate text-sm font-medium text-fg">{title}</div>
              <Badge variant="neutral">{kind}</Badge>
            </div>
            <div className="mt-1 truncate text-sm text-fg-muted">{url}</div>
            <div className="mt-1.5 text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
              Posted {formatDateTime(artifact.createdAt)}
            </div>
          </div>
          <ExternalLink className="mt-1 size-4 shrink-0 text-fg-subtle group-hover:text-accent-300" />
        </a>
      )
    }
  }

  if (typeof data['path'] === 'string' && (data['path'] as string).trim()) {
    return <FileArtefactButton jobId={jobId} artifact={artifact} />
  }

  return <JsonArtefactView artifact={artifact} />
}

function ArtifactIcon({ kind }: { kind: string }) {
  return (
    <div className="rounded-lg border border-line bg-overlay p-2 text-fg-muted">
      {kindIcon(kind)}
    </div>
  )
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
        className="group flex w-full items-start gap-3 rounded-2xl border border-line bg-overlay/40 px-4 py-3 text-left transition-colors hover:border-accent-500/30 hover:bg-overlay/60"
      >
        <ArtifactIcon kind={artifact.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="truncate text-sm font-medium text-fg">{artifact.title}</div>
            <Badge variant="neutral">{artifact.kind}</Badge>
          </div>
          <div className="mt-1 truncate font-mono text-xs text-fg-subtle">{path}</div>
          <div className="mt-1.5 text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
            Posted {formatDateTime(artifact.createdAt)}
          </div>
        </div>
        <Eye className="mt-1 size-4 shrink-0 text-fg-subtle group-hover:text-accent-300" />
      </button>

      {open ? <ArtefactModal jobId={jobId} artifact={artifact} onClose={() => setOpen(false)} /> : null}
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
  const isMarkdown = path.toLowerCase().endsWith('.md') || artifact.kind.endsWith('-md')

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{artifact.title}</DialogTitle>
          <div className="space-y-1 text-sm text-fg-muted">
            <div className="font-mono text-xs text-fg-subtle">{path}</div>
            <div>Posted {formatDateTime(artifact.createdAt)}</div>
          </div>
        </DialogHeader>
        <DialogBody>
          {error ? (
            <ErrorState title="Could not load artifact" message={error} />
          ) : !content ? (
            <div className="animate-pulse text-sm text-fg-subtle">Loading artifact content…</div>
          ) : isMarkdown ? (
            <Tabs defaultValue="rendered" className="space-y-3">
              <TabsList>
                <TabsTrigger value="rendered">Rendered</TabsTrigger>
                <TabsTrigger value="source">Source</TabsTrigger>
              </TabsList>
              <TabsContent value="rendered" className="rounded-2xl border border-line bg-canvas/40">
                <ScrollArea className="h-[60vh]">
                  <div
                    className="prose-coro space-y-3 p-5 text-sm leading-6 text-fg"
                    // Renderer escapes input — see markdown-mini for the contract.
                    dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(content) }}
                  />
                </ScrollArea>
              </TabsContent>
              <TabsContent value="source" className="rounded-2xl border border-line bg-canvas/60">
                <ScrollArea className="h-[60vh]">
                  <pre className="whitespace-pre-wrap break-words p-5 font-mono text-xs leading-6 text-fg">
                    {content}
                  </pre>
                </ScrollArea>
              </TabsContent>
            </Tabs>
          ) : (
            <ScrollArea className="h-[60vh] rounded-2xl border border-line bg-canvas/60">
              <div className="p-5">
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6 text-fg">
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
    <div className="overflow-hidden rounded-2xl border border-line bg-overlay/40">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-overlay/60"
      >
        <div className="flex min-w-0 items-center gap-3">
          <ArtifactIcon kind={artifact.kind} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-fg">{artifact.title}</div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle">{artifact.kind}</div>
          </div>
        </div>
        <ChevronDown className={cn('size-4 shrink-0 text-fg-subtle transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <pre className="max-h-80 overflow-auto border-t border-line bg-canvas/60 p-4 font-mono text-xs text-fg whitespace-pre-wrap break-words">
          {JSON.stringify(artifact.data, null, 2)}
        </pre>
      ) : null}
    </div>
  )
}
