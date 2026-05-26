import { useMemo, useState } from 'react'
import { Search, Sparkles } from 'lucide-react'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import {
  CATEGORY_LABELS,
  PROMPT_TEMPLATES,
  loadRecentTemplateIds,
  recordRecentTemplateId,
  type PromptCategory,
  type PromptTemplate,
} from '../lib/prompt-templates'
import { cn } from '../lib/utils'

interface SamplePromptDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (template: PromptTemplate) => void
  hasExistingDescription: boolean
}

export default function SamplePromptDrawer({
  open,
  onOpenChange,
  onSelect,
  hasExistingDescription,
}: SamplePromptDrawerProps) {
  const [category, setCategory] = useState<PromptCategory | 'recent'>('feature-small')
  const [query, setQuery] = useState('')

  const recentIds = useMemo(() => (open ? loadRecentTemplateIds() : []), [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list =
      category === 'recent'
        ? recentIds
            .map(id => PROMPT_TEMPLATES.find(t => t.id === id))
            .filter((t): t is PromptTemplate => Boolean(t))
        : PROMPT_TEMPLATES.filter(t => t.category === category)

    if (q) {
      list = PROMPT_TEMPLATES.filter(
        t =>
          t.title.toLowerCase().includes(q) ||
          t.preview.toLowerCase().includes(q) ||
          t.tags?.some(tag => tag.includes(q)),
      )
    }
    return list
  }, [category, query, recentIds])

  function handleUse(template: PromptTemplate) {
    if (hasExistingDescription && template.description) {
      const ok = window.confirm('Replace your current description with this example?')
      if (!ok) return
    }
    recordRecentTemplateId(template.id)
    onSelect(template)
    onOpenChange(false)
  }

  const categories = Object.keys(CATEGORY_LABELS) as PromptCategory[]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-w-3xl flex-col gap-0 max-h-[min(720px,calc(100vh-2rem))]">
        <DialogHeader className="shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-accent-300" />
            <DialogTitle>Start from an example</DialogTitle>
          </div>
          <DialogDescription>
            Pick a template to pre-fill your description. Swap in your repo, endpoints, and specifics.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
            <Input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search examples…"
              className="pl-9"
            />
          </div>

          <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
            <nav className="space-y-1 overflow-y-auto">
              {recentIds.length > 0 ? (
                <CategoryButton
                  active={category === 'recent'}
                  label="Recent"
                  blurb="Recently used"
                  onClick={() => setCategory('recent')}
                />
              ) : null}
              {categories.map(cat => (
                <CategoryButton
                  key={cat}
                  active={category === cat}
                  label={CATEGORY_LABELS[cat].label}
                  blurb={CATEGORY_LABELS[cat].blurb}
                  count={PROMPT_TEMPLATES.filter(t => t.category === cat).length}
                  onClick={() => setCategory(cat)}
                />
              ))}
            </nav>

            <div className="min-h-0 space-y-2 overflow-y-auto pr-1">
              {filtered.length === 0 ? (
                <div className="rounded-xl border border-line bg-overlay/30 p-4 text-sm text-fg-muted">
                  No examples match your search.
                </div>
              ) : (
                filtered.map(template => (
                  <div
                    key={template.id}
                    className="rounded-xl border border-line bg-overlay/30 p-4 transition-colors hover:border-line-strong"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-fg">{template.title}</div>
                        <p className="mt-1 text-xs leading-relaxed text-fg-muted">{template.preview}</p>
                      </div>
                      <Button type="button" size="sm" variant="secondary" onClick={() => handleUse(template)}>
                        Use this
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function CategoryButton({
  active,
  label,
  blurb,
  count,
  onClick,
}: {
  active: boolean
  label: string
  blurb: string
  count?: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors',
        active
          ? 'border-accent-500/40 bg-accent-500/10 text-fg'
          : 'border-transparent text-fg-muted hover:bg-overlay/50 hover:text-fg',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{label}</span>
        {count !== undefined ? (
          <span className="text-[10px] tabular-nums text-fg-subtle">{count}</span>
        ) : null}
      </div>
      <div className="mt-0.5 text-[11px] leading-4 text-fg-subtle">{blurb}</div>
    </button>
  )
}

/** Trigger pill placed next to the description field. */
export function SamplePromptTrigger({ onClick }: { onClick: () => void }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick} className="shrink-0">
      <Sparkles className="size-3.5" />
      Start from an example
    </Button>
  )
}
