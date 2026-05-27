import { useCallback, useEffect, useState } from 'react'
import {
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileJson2,
  FileText,
  GitPullRequest,
  Link2,
  PencilLine,
  RotateCcw,
  Save,
  X,
} from 'lucide-react'
import type { Artifact } from '../types'
import { formatDateTime } from '../lib/format'
import {
  artifactIsEditable,
  artifactIsMarkdown,
  fetchArtifactContent,
  invalidateArtifactContent,
  saveArtifactContent,
} from '../lib/artifact-content'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { ScrollArea } from './ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import { Textarea } from './ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'
import { renderInlineMarkdown } from './intelligence/markdown-mini'
import ErrorState from './common/error-state'
import { cn } from '../lib/utils'

interface ArtifactLinkProps {
  jobId: string
  artifact: Artifact
}

/**
 * Renders a single artefact entry. The `kind` drives how it is displayed:
 *
 *   - `pr-link` / `url`  → external link
 *   - `plan-md`, `report-md`, `spec-md`, `evaluation-md`, `analysis-contract`,
 *                          and any other kind whose `data.path` is set →
 *                          opens a modal that fetches the file body and lets
 *                          the developer read, copy, download, or edit it.
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
            {artifact.editedAt ? (
              <span className="rounded-full bg-warning-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-warning-300">
                Edited
              </span>
            ) : null}
          </div>
          <div className="mt-1 truncate font-mono text-xs text-fg-subtle">{path}</div>
          <div className="mt-1.5 text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
            Posted {formatDateTime(artifact.createdAt)}
            {artifact.editedAt ? ` · Edited ${formatDateTime(artifact.editedAt)}` : ''}
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
  const [serverContent, setServerContent] = useState<string | null>(null)
  const [draft, setDraft] = useState<string>('')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [editedAt, setEditedAt] = useState<string | undefined>(artifact.editedAt)
  const isMarkdown = artifactIsMarkdown(artifact)
  const editable = artifactIsEditable(artifact)

  useEffect(() => {
    let cancelled = false
    setServerContent(null)
    setDraft('')
    setError(null)
    fetchArtifactContent(jobId, artifact.id)
      .then(text => {
        if (cancelled) return
        setServerContent(text)
        setDraft(text)
      })
      .catch(err => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [jobId, artifact.id, editedAt])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editing) onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, editing])

  const handleCopy = useCallback(async () => {
    if (serverContent == null) return
    try {
      await navigator.clipboard.writeText(serverContent)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }, [serverContent])

  const handleDownload = useCallback(() => {
    if (serverContent == null) return
    const rawPath = (artifact.data['path'] as string) ?? `${artifact.kind}.txt`
    const filename = rawPath.split('/').pop() ?? `${artifact.id}.txt`
    const blob = new Blob([serverContent], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [serverContent, artifact.data, artifact.id, artifact.kind])

  const handleSave = useCallback(async () => {
    if (serverContent == null) return
    setSaving(true)
    setSaveError(null)
    try {
      const updated = await saveArtifactContent(jobId, artifact.id, draft)
      setServerContent(draft)
      setEditedAt(updated.editedAt)
      setEditing(false)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [jobId, artifact.id, draft, serverContent])

  const handleRevert = useCallback(() => {
    invalidateArtifactContent(jobId, artifact.id)
    setServerContent(null)
    setDraft('')
    setError(null)
    fetchArtifactContent(jobId, artifact.id)
      .then(text => {
        setServerContent(text)
        setDraft(text)
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : String(err))
      })
  }, [jobId, artifact.id])

  const dirty = editing && draft !== serverContent
  const path = artifact.data['path'] as string

  return (
    <TooltipProvider delayDuration={250}>
      <Dialog open onOpenChange={open => { if (!open && !editing) onClose() }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{artifact.title}</DialogTitle>
            <div className="space-y-1 text-sm text-fg-muted">
              <div className="font-mono text-xs text-fg-subtle">{path}</div>
              <div>
                Posted {formatDateTime(artifact.createdAt)}
                {editedAt ? (
                  <span className="ml-2 text-warning-300">· Edited {formatDateTime(editedAt)}</span>
                ) : null}
              </div>
            </div>
          </DialogHeader>
          <DialogBody>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                {!editing ? (
                  <>
                    <ModalIconButton tooltip={copied ? 'Copied!' : 'Copy contents'} onClick={handleCopy} disabled={!serverContent}>
                      <Copy />
                    </ModalIconButton>
                    <ModalIconButton tooltip="Download" onClick={handleDownload} disabled={!serverContent}>
                      <Download />
                    </ModalIconButton>
                    <ModalIconButton tooltip="Re-fetch from disk" onClick={handleRevert} disabled={!serverContent}>
                      <RotateCcw />
                    </ModalIconButton>
                    {editable ? (
                      <ModalIconButton tooltip="Edit this artifact" onClick={() => setEditing(true)} disabled={!serverContent}>
                        <PencilLine />
                      </ModalIconButton>
                    ) : (
                      <ModalIconButton tooltip="This file type is not editable from the dashboard" disabled>
                        <PencilLine />
                      </ModalIconButton>
                    )}
                  </>
                ) : (
                  <>
                    <Button type="button" size="sm" variant="primary" onClick={handleSave} disabled={saving || !dirty}>
                      <Save />
                      {saving ? 'Saving…' : 'Save edits'}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setDraft(serverContent ?? '')
                        setSaveError(null)
                        setEditing(false)
                      }}
                      disabled={saving}
                    >
                      <X />
                      Cancel edit
                    </Button>
                  </>
                )}
              </div>
              {saveError ? <div className="text-xs text-danger-400">{saveError}</div> : null}
            </div>

            {error ? (
              <ErrorState title="Could not load artifact" message={error} />
            ) : !serverContent ? (
              <div className="animate-pulse text-sm text-fg-subtle">Loading artifact content…</div>
            ) : editing ? (
              <div className="space-y-2">
                <Textarea
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  disabled={saving}
                  spellCheck={false}
                  className="h-[60vh] w-full resize-none rounded-2xl border border-line bg-canvas/70 font-mono text-xs leading-6"
                />
              </div>
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
                      dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(serverContent) }}
                    />
                  </ScrollArea>
                </TabsContent>
                <TabsContent value="source" className="rounded-2xl border border-line bg-canvas/60">
                  <ScrollArea className="h-[60vh]">
                    <pre className="whitespace-pre-wrap break-words p-5 font-mono text-xs leading-6 text-fg">
                      {serverContent}
                    </pre>
                  </ScrollArea>
                </TabsContent>
              </Tabs>
            ) : (
              <ScrollArea className="h-[60vh] rounded-2xl border border-line bg-canvas/60">
                <div className="p-5">
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6 text-fg">
                    {serverContent}
                  </pre>
                </div>
              </ScrollArea>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}

function ModalIconButton({
  children,
  tooltip,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  tooltip: string
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          className={cn(
            'inline-flex size-8 items-center justify-center rounded-lg text-fg-muted transition-colors',
            'hover:bg-overlay hover:text-fg disabled:pointer-events-none disabled:opacity-50',
            '[&_svg]:size-4',
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
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
