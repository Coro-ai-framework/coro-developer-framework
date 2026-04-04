import { STATUS_ESCALATED } from '../jobs/types'
import { ToolContext } from './types'

export async function markPhaseComplete(
  _input: Record<string, never>,
  ctx: ToolContext,
): Promise<unknown> {
  ctx.job._signals = { ...ctx.job._signals, phaseComplete: true }
  return { phaseComplete: true }
}

export async function awaitEvent(
  input: { eventName: string; prId?: number },
  ctx: ToolContext,
): Promise<unknown> {
  ctx.job._signals = {
    ...ctx.job._signals,
    awaitingEvent: input.eventName,
    awaitingPrId: input.prId,
  }
  return { awaiting: input.eventName, prId: input.prId ?? null }
}

export async function escalate(
  input: { reason: string },
  ctx: ToolContext,
): Promise<unknown> {
  await ctx.registry.updateJob(ctx.job.id, {
    status: STATUS_ESCALATED,
    escalationMessage: input.reason,
  })
  ctx.logger.warn({ jobId: ctx.job.id, reason: input.reason }, 'Job escalated')
  return { escalated: true, reason: input.reason }
}

export async function log(
  input: { message: string },
  ctx: ToolContext,
): Promise<unknown> {
  await ctx.registry.appendLog(ctx.job.id, input.message)
  return null
}
