import { CheckCircle2, MessageSquareText } from 'lucide-react'
import { ScrollArea } from '../ui/scroll-area'
import { renderInlineMarkdown } from '../intelligence/markdown-mini'
import { formatDateTime } from '../../lib/format'
import { VERDICT_LABEL, type FindingSeverity, type ReviewVerdict } from '../../lib/reviews'
import { SeverityBadge, ToneBadge } from './review-badges'

export const REVIEW_DRAFT_KIND = 'review-draft'

interface DraftComment {
  path: string
  line: number
  severity: FindingSeverity
  category?: string
  title: string
  body: string
}

interface ReviewDraftData {
  status?: 'draft' | 'published'
  verdict?: ReviewVerdict
  body?: string
  comments?: DraftComment[]
  resolve?: { findingId: string; resolved: boolean }[]
  publishedAt?: string
  posts?: 'verdict' | 'comment' | 'pending'
}

/** What approving the draft does on the pull request. */
function approvalCopy(draft: ReviewDraftData, verdict: ReviewVerdict): string {
  const label = VERDICT_LABEL[verdict].toLowerCase()
  if (draft.posts === 'pending') {
    return 'Nothing is on the pull request yet. Approve to save this as a draft review only you can see; you submit it from the pull request.'
  }
  if (draft.posts === 'comment' && verdict !== 'comment') {
    return `Nothing is on the pull request yet. Approve to post the summary and comments as a comment. Your review settings never post a verdict, so it will not ${label}.`
  }
  switch (draft.posts) {
    case 'verdict':
      return `Nothing is on the pull request yet. Approve to post this review with the ${label} verdict. Request changes to have Coro revise it; you see the new draft before anything is posted.`
    default:
      return 'Nothing is on the pull request yet. Approve to post this review. Request changes to have Coro revise it; you see the new draft before anything is posted.'
  }
}

const VERDICT_TONE = { approve: 'success', request_changes: 'danger', comment: 'neutral' } as const

/** The review Coro will post on the pull request, shown at the approval checkpoint. */
export default function ReviewDraftBody({ data }: { data: Record<string, unknown> }) {
  const draft = data as ReviewDraftData
  const comments = Array.isArray(draft.comments) ? draft.comments : []
  const resolving = Array.isArray(draft.resolve) ? draft.resolve.length : 0
  const verdict = draft.verdict && draft.verdict in VERDICT_LABEL ? draft.verdict : 'comment'
  const published = draft.status === 'published'

  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-muted">
        {published
          ? `Posted on the pull request${draft.publishedAt ? ` ${formatDateTime(draft.publishedAt)}` : ''}.`
          : approvalCopy(draft, verdict)}
      </p>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <ToneBadge tone={VERDICT_TONE[verdict]} label={VERDICT_LABEL[verdict]} />
        <span className="text-fg-muted">
          {comments.length} inline comment{comments.length === 1 ? '' : 's'}
        </span>
        {resolving ? (
          <span className="inline-flex items-center gap-1 text-fg-muted">
            <CheckCircle2 className="size-3.5" /> {resolving} thread{resolving === 1 ? '' : 's'} to resolve
          </span>
        ) : null}
      </div>

      <ScrollArea className="h-[min(55vh,560px)] rounded-xl border border-line bg-canvas/40">
        <div className="space-y-4 p-4">
          <section className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-fg-subtle">
              <MessageSquareText className="size-3.5" /> Summary
            </div>
            {draft.body?.trim() ? (
              <div
                className="prose-coro space-y-2 text-sm leading-6 text-fg"
                dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(draft.body) }}
              />
            ) : (
              <p className="text-sm text-fg-subtle">No summary comment.</p>
            )}
          </section>

          {comments.length > 0 ? (
            <section className="space-y-2">
              <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-subtle">Inline comments</div>
              <ul className="space-y-2">
                {comments.map(comment => (
                  <li key={`${comment.path}:${comment.line}:${comment.title}`} className="space-y-1.5 rounded-xl border border-line bg-overlay/40 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <SeverityBadge severity={comment.severity} />
                      <span className="text-sm font-medium text-fg">{comment.title}</span>
                    </div>
                    <div className="truncate font-mono text-[11px] text-fg-subtle">
                      {comment.path}:{comment.line}
                    </div>
                    <div
                      className="prose-coro space-y-2 text-[13px] leading-6 text-fg-muted"
                      dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(comment.body) }}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  )
}
