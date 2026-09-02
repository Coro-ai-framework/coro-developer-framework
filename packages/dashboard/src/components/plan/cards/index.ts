import { defineCard, type CardRendererMap } from '../../activity/cards/types'
import BriefCard, { type BriefCardData } from './brief-card'

export const PLAN_CARD_RENDERERS: CardRendererMap = Object.fromEntries([
  defineCard<BriefCardData>('brief', BriefCard),
])
