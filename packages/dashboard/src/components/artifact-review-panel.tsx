import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Ban,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FileJson2,
  FileText,
  GitPullRequest,
  Link2,
  Maximize2,
  MessageSquare,
  PencilLine,
  RotateCcw,
  Save,
  X,
} from 'lucide-react'
import type { Artifact } from '../types'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import { ScrollArea } from './ui/scroll-area'
import { Badge } from './ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { renderInlineMarkdown } from './intelligence/markdown-mini'
import ErrorState from './common/error-state'
import { formatDateTime } from '../lib/format'
import {
  artifactHasFileBody,
  artifactIsEditable,
  artifactIsMarkdown,
  fetchArtifactContent,
  invalidateArtifactContent,
  saveArtifactContent,
} from '../lib/artifact-content'
import { cn } from '../lib/utils'

export interface ArtifactReviewPanelProps {
  jobId: string
  artifacts: Artifact[]
  phaseLabel: string
  onApprove: () => void
  onRequestChanges: (msg: string) => void
  onCancel: () => void
  sending?: boolean
}

/**
 * Inline review surface shown during interactive checkpoints. The panel
 * sits inside the job detail flow (no fixed-height ancestor), so the
 * artefact reader takes responsibility for its own scroll height via
 * `h-[min(60vh,640px)]`. We previously used `max-h-*` here which left
 * Radix's ScrollArea viewport unconstrained and effectively disabled
 * scrolling for long markdown — see the bug repro in the run that
 * triggered this redesign.
 */
export default function ArtifactReviewPanel({
  jobId,
  artifacts,
  phaseLabel,
  onApprove,
  onRequestChanges,
  onCancel,
  sending = false,
}: ArtifactReviewPanelProps) {
  const [activeId, setActiveId] = useState(artifacts[0]?.id ?? '')
  const [showChanges, setShowChanges] = useState(false)
  const [changeText, setChangeText] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [fullScreenId, setFullScreenId] = useState<string | null>(null)

  useEffect(() => {
    if (artifacts.length > 0 && !artifacts.some(a => a.id === activeId)) {
      setActiveId(artifacts[0].id)
    }
  }, [artifacts, activeId])

  const active = artifacts.find(a => a.id === activeId) ?? artifacts[0]
  const isEditingActive = !!active && editingId === active.id
  // Approval is gated on any in-flight edit — forces the developer to
  // either save or cancel before progressing the run.
  const approveDisabled = sending || editingId !== null

  return (
    <TooltipProvider delayDuration={250}>
      <div className="overflow-hidden rounded-2xl border border-line bg-overlay/30">
        <header className="space-y-1 border-b border-line px-4 py-3">
          <div className="text-sm font-semibold text-fg">
            Review what Coro produced in the <span className="font-mono">{phaseLabel}</span> phase
          </div>
          <p className="text-xs text-fg-muted">
            Read the output below, edit it if needed, then approve or request changes.
          </p>
        </header>

        {artifacts.length > 1 ? (
          <ArtifactTabsRail
            artifacts={artifacts}
            activeId={activeId}
            onChange={id => {
              setActiveId(id)
              setEditingId(null)
            }}
            editingId={editingId}
          />
        ) : null}

        {active ? (
          <ArtifactViewerBody
            jobId={jobId}
            artifact={active}
            editing={isEditingActive}
            disabled={sending}
            onStartEdit={() => setEditingId(active.id)}
            onCancelEdit={() => setEditingId(null)}
            onSaved={() => setEditingId(null)}
            onOpenFullScreen={() => setFullScreenId(active.id)}
          />
        ) : null}

        <div className="space-y-3 border-t border-line bg-overlay/40 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="button"
                    variant="success"
                    size="sm"
                    disabled={approveDisabled}
                    onClick={onApprove}
                  >
                    <CheckCircle2 />
                    Approve and continue
                  </Button>
                </span>
              </TooltipTrigger>
              {editingId !== null ? (
                <TooltipContent>Save or cancel your edit first.</TooltipContent>
              ) : null}
            </Tooltip>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={sending}
              onClick={() => setShowChanges(v => !v)}
            >
              <MessageSquare />
              {showChanges ? 'Hide change request' : 'Request changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={sending}
              onClick={() => {
                if (window.confirm('Cancel this run?')) onCancel()
              }}
            >
              <Ban />
              Cancel run
            </Button>
          </div>

          {showChanges ? (
            <div className="space-y-2">
              <Textarea
                rows={3}
                value={changeText}
                onChange={e => setChangeText(e.target.value)}
                placeholder="Describe what should change before continuing…"
                disabled={sending}
              />
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  disabled={sending || !changeText.trim()}
                  onClick={() => {
                    onRequestChanges(changeText.trim())
                    setChangeText('')
                    setShowChanges(false)
                  }}
                >
                  Send feedback
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-[11px] text-fg-subtle">
              You can also send any message to Coro using the message box below.
            </p>
          )}
        </div>
      </div>

      {fullScreenId && active && active.id === fullScreenId ? (
        <ArtifactFullScreenDialog
          jobId={jobId}
          artifact={active}
          onClose={() => setFullScreenId(null)}
        />
      ) : null}
    </TooltipProvider>
  )
}

// ── Multi-artefact selector ─────────────────────────────────────────────────

function ArtifactTabsRail({
  artifacts,
  activeId,
  onChange,
  editingId,
}: {
  artifacts: Artifact[]
  activeId: string
  onChange: (id: string) => void
  editingId: string | null
}) {
  return (
    <div className="overflow-x-auto border-b border-line bg-overlay/20 px-2 py-2">
      <div className="flex min-w-max items-center gap-1">
        {artifacts.map(a => {
          const isActive = a.id === activeId
          const dirty = editingId === a.id
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => onChange(a.id)}
              className={cn(
                'group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors',
                isActive
                  ? 'bg-overlay text-fg ring-1 ring-line-strong'
                  : 'text-fg-muted hover:bg-overlay/70 hover:text-fg',
              )}
            >
              <ArtifactKindIcon kind={a.kind} />
              <span className="max-w-[18ch] truncate font-medium">{a.title || a.kind || a.id}</span>
              <Badge variant="neutral" className="text-[10px] uppercase">
                {a.kind}
              </Badge>
              {dirty ? (
                <span className="rounded-full bg-warning-500/20 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-warning-300">
                  Editing
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Reader body (handles file / link / json kinds) ──────────────────────────

interface ArtifactViewerBodyProps {
  jobId: string
  artifact: Artifact
  editing: boolean
  disabled: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSaved: () => void
  onOpenFullScreen: () => void
}

function ArtifactViewerBody({
  jobId,
  artifact,
  editing,
  disabled,
  onStartEdit,
  onCancelEdit,
  onSaved,
  onOpenFullScreen,
}: ArtifactViewerBodyProps) {
  // PR / URL artefacts have no file body — render the link card inline so
  // the developer doesn't see a raw JSON dump during the review phase.
  if (!artifactHasFileBody(artifact)) {
    return (
      <div className="space-y-3 px-4 py-4">
        <ArtifactMetadataRow artifact={artifact} />
        <ArtifactNonFileBody artifact={artifact} />
      </div>
    )
  }

  return (
    <ArtifactFileBody
      jobId={jobId}
      artifact={artifact}
      editing={editing}
      disabled={disabled}
      onStartEdit={onStartEdit}
      onCancelEdit={onCancelEdit}
      onSaved={onSaved}
      onOpenFullScreen={onOpenFullScreen}
    />
  )
}

function ArtifactMetadataRow({ artifact }: { artifact: Artifact }) {
  const path = typeof artifact.data['path'] === 'string' ? (artifact.data['path'] as string) : ''
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
      <span className="font-medium text-fg">{artifact.title || artifact.kind}</span>
      <Badge variant="neutral">{artifact.kind}</Badge>
      {path ? <span className="truncate font-mono text-fg-subtle">{path}</span> : null}
      <span className="text-fg-subtle">Posted {formatDateTime(artifact.createdAt)}</span>
      {artifact.editedAt ? (
        <span className="text-warning-300">Edited {formatDateTime(artifact.editedAt)}</span>
      ) : null}
    </div>
  )
}

function ArtifactNonFileBody({ artifact }: { artifact: Artifact }) {
  const url = typeof artifact.data['url'] === 'string' ? (artifact.data['url'] as string) : null
  if ((artifact.kind === 'pr-link' || artifact.kind === 'url') && url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex items-start gap-3 rounded-2xl border border-line bg-overlay/40 px-4 py-3 transition-colors hover:border-accent-500/30 hover:bg-overlay/60"
      >
        <div className="rounded-lg border border-line bg-overlay p-2 text-fg-muted">
          {artifact.kind === 'pr-link' ? <GitPullRequest className="size-4" /> : <Link2 className="size-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-fg">{artifact.title}</div>
          <div className="mt-0.5 truncate text-sm text-fg-muted">{url}</div>
        </div>
        <ExternalLink className="mt-1 size-4 shrink-0 text-fg-subtle group-hover:text-accent-300" />
      </a>
    )
  }
  // Anything else: structured JSON dump in a scrollable container.
  return (
    <ScrollArea className="h-[min(40vh,360px)] rounded-xl border border-line bg-canvas/60">
      <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6 text-fg">
        {JSON.stringify(artifact.data, null, 2)}
      </pre>
    </ScrollArea>
  )
}

// ── File-backed body (markdown / json / text with edit support) ─────────────

function ArtifactFileBody({
  jobId,
  artifact,
  editing,
  disabled,
  onStartEdit,
  onCancelEdit,
  onSaved,
  onOpenFullScreen,
}: Omit<ArtifactViewerBodyProps, 'onOpenFullScreen'> & { onOpenFullScreen: () => void }) {
  const [serverContent, setServerContent] = useState<string | null>(null)
  const [draft, setDraft] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const fetchKeyRef = useRef<string>('')

  const isMarkdown = artifactIsMarkdown(artifact)
  const editable = artifactIsEditable(artifact)

  // Refetch when the artefact id or its `editedAt` stamp changes (the
  // latter happens after a successful save — we deliberately don't trust
  // the cached body in that case).
  useEffect(() => {
    let cancelled = false
    const key = `${artifact.id}:${artifact.editedAt ?? ''}`
    fetchKeyRef.current = key
    setLoading(true)
    setError(null)
    fetchArtifactContent(jobId, artifact.id)
      .then(text => {
        if (cancelled || fetchKeyRef.current !== key) return
        setServerContent(text)
        setDraft(text)
        setLoading(false)
      })
      .catch(err => {
        if (cancelled || fetchKeyRef.current !== key) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [jobId, artifact.id, artifact.editedAt])

  const handleCopy = useCallback(async () => {
    if (serverContent == null) return
    try {
      await navigator.clipboard.writeText(serverContent)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Older browsers: surface a console hint, no destructive fallback.
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
      await saveArtifactContent(jobId, artifact.id, draft)
      setServerContent(draft)
      onSaved()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [jobId, artifact.id, draft, serverContent, onSaved])

  const handleCancelEdit = useCallback(() => {
    setDraft(serverContent ?? '')
    setSaveError(null)
    onCancelEdit()
  }, [serverContent, onCancelEdit])

  const handleRevert = useCallback(() => {
    invalidateArtifactContent(jobId, artifact.id)
    setServerContent(null)
    setLoading(true)
    setError(null)
    fetchArtifactContent(jobId, artifact.id)
      .then(text => {
        setServerContent(text)
        setDraft(text)
        setLoading(false)
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
  }, [jobId, artifact.id])

  const dirty = editing && draft !== serverContent

  const heightClass = 'h-[min(60vh,640px)]'

  return (
    <div className="space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <ArtifactMetadataRow artifact={artifact} />
        <ArtifactToolbar
          editing={editing}
          editable={editable}
          dirty={dirty}
          saving={saving}
          disabled={disabled || loading || !!error}
          copied={copied}
          onCopy={handleCopy}
          onDownload={handleDownload}
          onOpenFullScreen={onOpenFullScreen}
          onStartEdit={onStartEdit}
          onCancelEdit={handleCancelEdit}
          onSave={handleSave}
          onRevert={handleRevert}
        />
      </div>

      {loading ? (
        <div className={cn('flex items-center justify-center rounded-xl border border-line bg-canvas/40 text-sm text-fg-subtle', heightClass)}>
          <span className="animate-pulse">Loading artifact…</span>
        </div>
      ) : error ? (
        <ErrorState title="Could not load artifact" message={error} />
      ) : editing ? (
        <EditView
          draft={draft}
          onChange={setDraft}
          disabled={saving}
          heightClass={heightClass}
          saveError={saveError}
        />
      ) : isMarkdown ? (
        <RenderedSourceTabs content={serverContent ?? ''} heightClass={heightClass} />
      ) : (
        <SourceOnlyView content={serverContent ?? ''} heightClass={heightClass} />
      )}
    </div>
  )
}

// ── Toolbar ─────────────────────────────────────────────────────────────────

interface ArtifactToolbarProps {
  editing: boolean
  editable: boolean
  dirty: boolean
  saving: boolean
  disabled: boolean
  copied: boolean
  onCopy: () => void
  onDownload: () => void
  onOpenFullScreen: () => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
  onRevert: () => void
}

function ArtifactToolbar({
  editing,
  editable,
  dirty,
  saving,
  disabled,
  copied,
  onCopy,
  onDownload,
  onOpenFullScreen,
  onStartEdit,
  onCancelEdit,
  onSave,
  onRevert,
}: ArtifactToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {editing ? (
        <>
          <Button type="button" size="sm" variant="primary" onClick={onSave} disabled={saving || !dirty}>
            <Save />
            {saving ? 'Saving…' : 'Save edits'}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onCancelEdit} disabled={saving}>
            <X />
            Cancel edit
          </Button>
        </>
      ) : (
        <>
          <IconButton tooltip={copied ? 'Copied!' : 'Copy contents'} onClick={onCopy} disabled={disabled}>
            <Copy />
          </IconButton>
          <IconButton tooltip="Download" onClick={onDownload} disabled={disabled}>
            <Download />
          </IconButton>
          <IconButton tooltip="Re-fetch from disk" onClick={onRevert} disabled={disabled}>
            <RotateCcw />
          </IconButton>
          <IconButton tooltip="Open full screen" onClick={onOpenFullScreen} disabled={disabled}>
            <Maximize2 />
          </IconButton>
          {editable ? (
            <IconButton tooltip="Edit this artifact" onClick={onStartEdit} disabled={disabled}>
              <PencilLine />
            </IconButton>
          ) : (
            <IconButton tooltip="This file type is not editable from the dashboard" onClick={() => {}} disabled>
              <PencilLine />
            </IconButton>
          )}
        </>
      )}
    </div>
  )
}

function IconButton({
  children,
  tooltip,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  tooltip: string
  onClick: () => void
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

// ── Reader variants ─────────────────────────────────────────────────────────

function RenderedSourceTabs({ content, heightClass }: { content: string; heightClass: string }) {
  return (
    <Tabs defaultValue="rendered">
      <TabsList>
        <TabsTrigger value="rendered">Rendered</TabsTrigger>
        <TabsTrigger value="source">Source</TabsTrigger>
      </TabsList>
      <TabsContent value="rendered" className={cn('rounded-xl border border-line bg-canvas/40')}>
        <ScrollArea className={heightClass}>
          <div
            className="prose-coro space-y-3 p-4 text-sm leading-6 text-fg"
            dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(content) }}
          />
        </ScrollArea>
      </TabsContent>
      <TabsContent value="source" className={cn('rounded-xl border border-line bg-canvas/60')}>
        <ScrollArea className={heightClass}>
          <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6 text-fg">
            {content}
          </pre>
        </ScrollArea>
      </TabsContent>
    </Tabs>
  )
}

function SourceOnlyView({ content, heightClass }: { content: string; heightClass: string }) {
  const looksJson = content.trim().startsWith('{') || content.trim().startsWith('[')
  return (
    <ScrollArea className={cn(heightClass, 'rounded-xl border border-line bg-canvas/60')}>
      <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6 text-fg">
        {looksJson ? tryFormatJson(content) : content}
      </pre>
    </ScrollArea>
  )
}

function EditView({
  draft,
  onChange,
  disabled,
  heightClass,
  saveError,
}: {
  draft: string
  onChange: (value: string) => void
  disabled: boolean
  heightClass: string
  saveError: string | null
}) {
  return (
    <div className="space-y-2">
      <Textarea
        value={draft}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        spellCheck={false}
        className={cn(
          'w-full resize-none rounded-xl border border-line bg-canvas/70 font-mono text-xs leading-6',
          heightClass,
        )}
      />
      {saveError ? <div className="text-xs text-danger-400">{saveError}</div> : null}
    </div>
  )
}

function tryFormatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

function ArtifactKindIcon({ kind }: { kind: string }) {
  if (kind === 'pr-link') return <GitPullRequest className="size-3.5" />
  if (kind === 'url') return <Link2 className="size-3.5" />
  if (kind.endsWith('-md') || kind === 'analysis-contract') return <FileText className="size-3.5" />
  return <FileJson2 className="size-3.5" />
}

// ── Full-screen modal ──────────────────────────────────────────────────────

function ArtifactFullScreenDialog({
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
  const isMarkdown = artifactIsMarkdown(artifact)

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setError(null)
    fetchArtifactContent(jobId, artifact.id)
      .then(text => {
        if (!cancelled) setContent(text)
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [jobId, artifact.id, artifact.editedAt])

  const path = artifact.data['path'] as string | undefined

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{artifact.title}</DialogTitle>
          <div className="space-y-1 text-sm text-fg-muted">
            {path ? <div className="font-mono text-xs text-fg-subtle">{path}</div> : null}
            <div>
              Posted {formatDateTime(artifact.createdAt)}
              {artifact.editedAt ? (
                <span className="ml-2 text-warning-300">· Edited {formatDateTime(artifact.editedAt)}</span>
              ) : null}
            </div>
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
                <ScrollArea className="h-[70vh]">
                  <div
                    className="prose-coro space-y-3 p-5 text-sm leading-6 text-fg"
                    dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(content) }}
                  />
                </ScrollArea>
              </TabsContent>
              <TabsContent value="source" className="rounded-2xl border border-line bg-canvas/60">
                <ScrollArea className="h-[70vh]">
                  <pre className="whitespace-pre-wrap break-words p-5 font-mono text-xs leading-6 text-fg">
                    {content}
                  </pre>
                </ScrollArea>
              </TabsContent>
            </Tabs>
          ) : (
            <ScrollArea className="h-[70vh] rounded-2xl border border-line bg-canvas/60">
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
