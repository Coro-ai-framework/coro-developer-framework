import { useEffect, useMemo, useRef, useState } from 'react'
import { FileCode, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { ApiError, jsonRequest, requestJson } from '../../lib/http'
import type { IntelligenceLayer } from './layer-badge'
import PreflightPanel, { type PreflightResult } from './preflight-panel'

export type ArtefactKind = 'workflow' | 'agent' | 'skill' | 'memory'

interface NewArtefactDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  layer: IntelligenceLayer
  kind: ArtefactKind
  onCreated: (target: { layer: IntelligenceLayer; path: string }) => void
}

const KIND_LABEL: Record<ArtefactKind, string> = {
  workflow: 'Workflow',
  agent: 'Agent',
  skill: 'Skill',
  memory: 'Memory note',
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

// Pre-validated templates per kind. Keep in lock-step with the
// runner-side validator (intelligence-validator.ts) so we never
// scaffold something that immediately fails preflight.
function templateFor(kind: ArtefactKind, slug: string): { path: string; content: string } {
  switch (kind) {
    case 'workflow':
      return {
        path: `workflows/${slug}/workflow.md`,
        content: `---
display_name: ${slug}
description: New tenant workflow.
kind: job

initial_phase: planning
initial_status: queued

phases:
  - name: planning
    agent: agents/planner.md
    model: planning
    status: planning
---

# Workflow: ${slug}

Describe the purpose of this workflow.
`,
      }
    case 'agent':
      return {
        path: `agents/${slug}.md`,
        content: `# Agent: ${slug}

## Role

Describe what this agent is responsible for in one or two sentences.

## Procedure

1. First step.
2. Second step.
3. Third step.
`,
      }
    case 'skill':
      return {
        path: `.claude/skills/${slug}/SKILL.md`,
        content: `---
name: ${slug}
description: One-line description of what this skill teaches.
---

# ${slug}

## When to use

Describe the situations in which this skill should be invoked.

## Guidance

Provide the actual conventions, snippets, or domain knowledge.
`,
      }
    case 'memory':
      return {
        path: `memory/${slug}.md`,
        content: `# ${slug}

A short, durable insight worth remembering across jobs.
`,
      }
  }
}

export default function NewArtefactDialog({
  open,
  onOpenChange,
  layer,
  kind,
  onCreated,
}: NewArtefactDialogProps) {
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [path, setPath] = useState('')
  const [preflight, setPreflight] = useState<PreflightResult | null>(null)
  const [preflightLoading, setPreflightLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const debounceRef = useRef<number | null>(null)

  const slug = useMemo(() => slugify(name), [name])

  // Reset to template whenever the dialog opens for a new (layer, kind).
  useEffect(() => {
    if (!open) return
    const initial = templateFor(kind, 'my-' + kind)
    setName('my-' + kind)
    setContent(initial.content)
    setPath(initial.path)
    setPreflight(null)
    setSubmitError(null)
  }, [open, kind])

  // Re-derive path + (lightly) re-template when name changes. We only
  // overwrite the body if it still matches the previous template — that
  // way any user edits survive renames.
  useEffect(() => {
    if (!open) return
    const safeSlug = slug || 'my-' + kind
    const t = templateFor(kind, safeSlug)
    setPath(t.path)
    setContent(prev => {
      // If user has typed nothing custom, refresh the template body too.
      const looksLikeTemplate = prev.includes(`# Agent: my-`) ||
        prev.includes(`# Workflow: my-`) ||
        prev.startsWith(`---\nname: my-`) ||
        prev.startsWith(`# my-`)
      return looksLikeTemplate ? t.content : prev
    })
  }, [slug, kind, open])

  // Debounced preflight on every content/path change.
  useEffect(() => {
    if (!open || !path || !content) {
      setPreflight(null)
      return
    }
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      setPreflightLoading(true)
      requestJson<PreflightResult>(
        '/intelligence/preflight',
        jsonRequest({ path, content }, { method: 'POST' }),
      )
        .then(r => setPreflight(r))
        .catch(() => setPreflight(null))
        .finally(() => setPreflightLoading(false))
    }, 250)
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
  }, [open, path, content])

  async function submit() {
    if (!preflight?.ok || submitting) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      await requestJson<{ layer: string; path: string; bytes: number }>(
        '/intelligence/file',
        jsonRequest({ layer, path, content }, { method: 'PUT' }),
      )
      onCreated({ layer, path })
      onOpenChange(false)
    } catch (err) {
      const msg =
        err instanceof ApiError ? `${err.message} (HTTP ${err.status})` : (err as Error).message
      setSubmitError(msg)
    } finally {
      setSubmitting(false)
    }
  }

  const canSubmit = preflight?.ok === true && !submitting && !preflightLoading

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-w-3xl flex-col gap-0 max-h-[min(820px,calc(100vh-2rem))]">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle className="flex items-center gap-2">
            <FileCode className="size-4 text-accent-300" />
            New {KIND_LABEL[kind]} in {layer === 'tenant' ? 'Custom' : layer}
          </DialogTitle>
          <DialogDescription>
            Pick a name, edit the scaffolded content, and Coro pre-validates before saving.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex-1 min-h-0 overflow-y-auto space-y-4 px-6 pb-6">
          <div className="grid grid-cols-[160px_1fr] items-center gap-3">
            <label className="text-xs font-medium text-fg-muted">Name</label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={`my-${kind}`}
              autoFocus
            />
            <label className="text-xs font-medium text-fg-muted">Resolved path</label>
            <code className="truncate rounded bg-overlay/60 px-2 py-1 font-mono text-[11px] text-fg-subtle">
              {path}
            </code>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-fg-muted">Content</label>
              <span className="text-[10px] text-fg-subtle">{content.length} chars</span>
            </div>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              spellCheck={false}
              className="h-[280px] w-full resize-y rounded-md border border-line bg-canvas/60 px-3 py-2 font-mono text-[12px] leading-relaxed text-fg outline-none focus:border-accent-400"
            />
          </div>

          <PreflightPanel preflight={preflight} loading={preflightLoading} />

          {submitError ? (
            <div className="rounded-md border border-danger-500/50 bg-danger-500/10 px-3 py-2 text-[12px] text-danger-400">
              {submitError}
            </div>
          ) : null}
        </DialogBody>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-6 py-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={!canSubmit}>
            {submitting ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            Create
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
