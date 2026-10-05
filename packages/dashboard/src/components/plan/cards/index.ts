import { defineCard, type CardRendererMap } from '../../activity/cards/types'
import FindingsCard, { type FindingsCardData } from './findings-card'
import PermissionCard, { type PermissionCardData } from './permission-card'
import RunCard, { type RunCardData } from './run-card'

export const PLAN_CARD_RENDERERS: CardRendererMap = Object.fromEntries([
  defineCard<FindingsCardData>('findings', FindingsCard),
  defineCard<RunCardData>('run', RunCard),
  defineCard<PermissionCardData>('permission', PermissionCard),
])
