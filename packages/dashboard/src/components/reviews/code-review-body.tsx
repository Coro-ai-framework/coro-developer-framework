import { ScrollArea } from '../ui/scroll-area'
import { renderInlineMarkdown } from '../intelligence/markdown-mini'
import { formatDateTime } from '../../lib/format'
import { SEVERITY_ORDER, type FindingSeverity } from '../../lib/reviews'
import { Badge } from '../ui/badge'
import { SeverityBadge, SeverityCounts } from './review-badges'

export const CODE_REVIEW_KIND = 'code-review'

interface CodeReviewFinding {
  lens?: string
  severity: FindingSeverity
  category?: string
  path?: string
  line?: number
  title: string
  body?: string
  verified?: boolean
  dropped?: boolean
}

interface CodeReviewItem {
  workItem?: string
  base?: string
  passes?: number
  updatedAt?: string
  files?: number
  lenses?: { name: string; findings: number; costUsd?: number }[]
  findings?: CodeReviewFinding[]
  notes?: string[]
}

function isSeverity(value: unknown): value is FindingSeverity {
  return typeof value === 'string' && (SEVERITY_ORDER as readonly string[]).includes(value)
}

/**
 * What the review lenses found in the coder's local changes, before the pull
 * request exists. Read-only: these findings go to the coder, not the SCM.
 */
export default function CodeReviewBody({ data }: { data: Record<string, unknown> }) {
  const items = Array.isArray(data['items']) ? (data['items'] as CodeReviewItem[]) : []

  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-muted">
        Findings from the review lenses on the local changes. They go to the coder before the pull request is opened; nothing is posted.
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-fg-subtle">No review has run yet.</p>
      ) : (
        <ScrollArea className="h-[min(55vh,560px)] rounded-xl border border-line bg-canvas/40">
          <div className="space-y-5 p-4">
            {items.map(item => (
              <CodeReviewItemView key={item.workItem ?? 'job'} item={item} />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}

function CodeReviewItemView({ item }: { item: CodeReviewItem }) {
  const findings = (Array.isArray(item.findings) ? item.findings : []).filter(
    finding => !finding.dropped && isSeverity(finding.severity),
  )
  const counts = { blocker: 0, major: 0, minor: 0, nit: 0 } satisfies Record<FindingSeverity, number>
  for (const finding of findings) counts[finding.severity] += 1
  const ordered = [...findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  )
  const lenses = Array.isArray(item.lenses) ? item.lenses : []

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-sm font-medium text-fg">{item.workItem && item.workItem !== 'job' ? item.workItem : 'This job'}</span>
        <Badge variant="neutral">pass {item.passes ?? 1}</Badge>
        {item.base ? <span className="font-mono text-fg-subtle">vs {item.base}</span> : null}
        {typeof item.files === 'number' ? (
          <span className="text-fg-muted">{item.files} file{item.files === 1 ? '' : 's'}</span>
        ) : null}
        {item.updatedAt ? <span className="text-fg-subtle">{formatDateTime(item.updatedAt)}</span> : null}
      </div>
      <SeverityCounts counts={counts} />
      {lenses.length > 0 ? (
        <div className="text-[11px] text-fg-subtle">
          Lenses: {lenses.map(lens => `${lens.name} (${lens.findings})`).join(', ')}
        </div>
      ) : null}

      {ordered.length > 0 ? (
        <ul className="space-y-2">
          {ordered.map(finding => (
            <li key={`${finding.path ?? ''}:${finding.line ?? ''}:${finding.title}`} className="space-y-1.5 rounded-xl border border-line bg-overlay/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <SeverityBadge severity={finding.severity} />
                <span className="text-sm font-medium text-fg">{finding.title}</span>
                {finding.lens ? <Badge variant="neutral">{finding.lens}</Badge> : null}
                {finding.verified ? <Badge variant="neutral">verified</Badge> : null}
              </div>
              {finding.path ? (
                <div className="truncate font-mono text-[11px] text-fg-subtle">
                  {finding.path}
                  {finding.line !== undefined ? `:${finding.line}` : ''}
                </div>
              ) : null}
              {finding.body ? (
                <div
                  className="prose-coro space-y-2 text-[13px] leading-6 text-fg-muted"
                  dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(finding.body) }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-subtle">The lenses found nothing at or above the severity floor.</p>
      )}

      {Array.isArray(item.notes) && item.notes.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-fg-muted">
          {item.notes.map(note => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
