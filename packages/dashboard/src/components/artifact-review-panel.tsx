import { useEffect, useState } from 'react'
import {
  Ban,
  CheckCircle2,
  MessageSquare,
} from 'lucide-react'
import type { Artifact } from '../types'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Tabs, TabsList, TabsTrigger } from './ui/tabs'
import { ScrollArea } from './ui/scroll-area'
import { renderInlineMarkdown } from './intelligence/markdown-mini'
import { requestText } from '../lib/http'
import ErrorState from './common/error-state'
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

  useEffect(() => {
    if (artifacts.length > 0 && !artifacts.some(a => a.id === activeId)) {
      setActiveId(artifacts[0].id)
    }
  }, [artifacts, activeId])

  const active = artifacts.find(a => a.id === activeId) ?? artifacts[0]

  return (
    <div className="space-y-4 rounded-2xl border border-line bg-overlay/30 p-4">
      <div>
        <div className="text-sm font-semibold text-fg">
          Review what Coro produced in the <span className="font-mono">{phaseLabel}</span> phase
        </div>
        <p className="mt-1 text-xs text-fg-muted">
          Read the output below, then approve or request changes.
        </p>
      </div>

      {artifacts.length > 1 ? (
        <Tabs value={activeId} onValueChange={setActiveId}>
          <TabsList className="flex h-auto flex-wrap gap-1">
            {artifacts.map(a => (
              <TabsTrigger key={a.id} value={a.id} className="text-xs">
                {a.title || a.kind || a.id}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      ) : null}

      {active ? (
        <ArtifactViewer jobId={jobId} artifact={active} />
      ) : null}

      <div className="flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="success" size="sm" disabled={sending} onClick={onApprove}>
            <CheckCircle2 />
            Approve and continue
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={sending}
            onClick={() => setShowChanges(v => !v)}
          >
            <MessageSquare />
            Request changes
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
      ) : null}

      <p className="text-[11px] text-fg-subtle">
        You can also send any message to Coro using the message box below.
      </p>
    </div>
  )
}

function ArtifactViewer({ jobId, artifact }: { jobId: string; artifact: Artifact }) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const path = typeof artifact.data['path'] === 'string' ? artifact.data['path'] : ''
  const kind = artifact.kind ?? ''
  const isMarkdown =
    path.toLowerCase().endsWith('.md') ||
    kind.endsWith('-md') ||
    kind.includes('md')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    if (path) {
      void requestText(`/jobs/${jobId}/artifacts/${artifact.id}/content`)
        .then(text => {
          if (!cancelled) {
            setContent(text)
            setLoading(false)
          }
        })
        .catch(err => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err))
            setLoading(false)
          }
        })
      return () => {
        cancelled = true
      }
    }

    setContent(JSON.stringify(artifact.data, null, 2))
    setLoading(false)
    return () => {
      cancelled = true
    }
  }, [jobId, artifact.id, artifact.data, path])

  if (loading) {
    return <div className="animate-pulse text-sm text-fg-subtle">Loading artifact…</div>
  }
  if (error) {
    return <ErrorState title="Could not load artifact" message={error} />
  }
  if (!content) {
    return <div className="text-sm text-fg-muted">No content available for this artifact.</div>
  }

  if (isMarkdown) {
    return (
      <ScrollArea className={cn('max-h-[420px] rounded-xl border border-line bg-canvas/40')}>
        <div
          className="prose-coro space-y-3 p-4 text-sm leading-6 text-fg"
          dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(content) }}
        />
      </ScrollArea>
    )
  }

  const isJson =
    path.toLowerCase().endsWith('.json') ||
    kind.includes('json') ||
    content.trim().startsWith('{')

  return (
    <ScrollArea className="max-h-[420px] rounded-xl border border-line bg-canvas/60">
      <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6 text-fg">
        {isJson ? tryFormatJson(content) : content}
      </pre>
    </ScrollArea>
  )
}

function tryFormatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
