import type { ActivityCard } from './types'
import type { CardRendererMap } from './types'

interface CardHostProps {
  itemId: string
  card: ActivityCard
  cardRenderers: CardRendererMap
}

export default function CardHost({ itemId, card, cardRenderers }: CardHostProps) {
  const render = cardRenderers[card.type]
  if (!render) {
    return (
      <div className="rounded-2xl border border-line bg-overlay/20 px-3.5 py-2.5 text-[12.5px] text-fg-subtle">
        Unsupported card: {card.type}
      </div>
    )
  }
  return <>{render({ data: card.data, itemId })}</>
}
