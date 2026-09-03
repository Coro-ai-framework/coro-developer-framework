import { ScanSearch } from 'lucide-react'
import CardShell from '../../activity/cards/card-shell'
import type { CardRenderProps } from '../../activity/cards/types'
import type { ActivityItem } from '../../activity/types'
import { Badge } from '../../ui/badge'
import { renderInlineMarkdown } from '../../intelligence/markdown-mini'
import { findingsTitle } from '../../../lib/intake-findings'
import { usePlanSession } from '../../../providers/plan-session'
import GenerateRunButton from '../generate-run-button'

export interface FindingsCardData {
  markdown: string
  state: 'current' | 'superseded'
}

function hasDraftRun(items: ActivityItem[]): boolean {
  return items.some(item => {
    if (item.kind !== 'card' || item.card.type !== 'run') return false
    const data = item.card.data as { state?: string }
    return data.state === 'draft'
  })
}

export default function FindingsCard({ data }: CardRenderProps<FindingsCardData>) {
  const { markdown, state } = data
  const current = state === 'current'
  const session = usePlanSession()
  const ready = session.readiness?.state === 'ready'
  const showGenerate =
    current && ready && !hasDraftRun(session.items) && !session.noLlm

  return (
    <CardShell
      icon={ScanSearch}
      title="Findings"
      summary={findingsTitle(markdown)}
      badges={current ? null : <Badge variant="neutral">Superseded</Badge>}
      dimmed={!current}
      defaultExpanded={current}
    >
      <div
        className="prose-coro space-y-3 text-sm leading-6 text-fg"
        dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(markdown) }}
      />
      {showGenerate ? (
        <GenerateRunButton
          layout="block"
          readiness={session.readiness}
          disabled={session.busy}
          onClick={() => void session.send('', { generateRun: true })}
        />
      ) : null}
    </CardShell>
  )
}
