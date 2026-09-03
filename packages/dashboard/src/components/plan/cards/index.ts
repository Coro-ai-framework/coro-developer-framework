import { defineCard, type CardRendererMap } from '../../activity/cards/types'
import RunCard, { type RunCardData } from './run-card'

export const PLAN_CARD_RENDERERS: CardRendererMap = Object.fromEntries([
  defineCard<RunCardData>('run', RunCard),
])
