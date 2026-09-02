import type { ReactNode } from 'react'

/** An opaque card in the feed. `type` is a registry key; `data` is the renderer's business. */
export interface ActivityCard {
  type: string
  data: unknown
}

export interface CardRenderProps<TData = unknown> {
  data: TData
  /** The enclosing ActivityItem id — useful as a stable key or DOM id. */
  itemId: string
}

export type CardRenderer<TData = unknown> = (props: CardRenderProps<TData>) => ReactNode
export type CardRendererMap = Record<string, CardRenderer>

/**
 * Register a typed renderer. This is the ONE place `data: unknown` is narrowed,
 * so consumers stay type-safe and the activity layer stays card-agnostic.
 */
export function defineCard<TData>(
  type: string,
  render: (props: CardRenderProps<TData>) => ReactNode,
): [string, CardRenderer] {
  return [type, ({ data, itemId }) => render({ data: data as TData, itemId })]
}
