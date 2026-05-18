// ── Hybrid Dispatcher ─────────────────────────────────────────────────────────
//
// Extends the base Dispatcher with cloud-initiated job dispatch. In hybrid mode,
// jobs can be triggered from the cloud (via dashboard or REST API) and forwarded
// to the runner via WebSocket. The runner then executes the job locally.

import type { WebSocketTransport } from '../state/ws-transport'
import { Dispatcher } from '../jobs/dispatcher'
import type { RunnerContext } from '../jobs/runner'
import type { JobInput } from '@coro/cloud-protocol'

/**
 * Wire the dispatcher to listen for cloud-initiated events delivered
 * through the WebSocket transport. This handles:
 *
 *   - event:webhook  → forwarded BB/Jira events that resume parked jobs
 *   - event:resume   → manual resume from cloud dashboard
 *   - event:message  → human message injection from cloud dashboard
 *   - proposal:apply → approved proposal that needs local git commit
 *
 * The base Dispatcher already handles `transport.onEvent()`, so this function
 * adds the job dispatch listener for cloud-initiated "run this job" commands.
 */
export function wireCloudJobDispatch(
  dispatcher: Dispatcher,
  transport: WebSocketTransport,
  ctx: RunnerContext,
): void {
  // The transport's onEvent handler is already wired by the base Dispatcher
  // constructor. Here we add a second-level listener for cloud-initiated
  // job dispatch commands that arrive as custom messages.

  // The transport delivers all cloud→runner messages through onEvent.
  // The base Dispatcher's handler deals with webhooks and resume events.
  // For job dispatch from cloud, the gateway sends event:dispatch which
  // we intercept by wrapping the transport's event handler.

  const originalHandler = (transport as unknown as { eventHandler?: (event: unknown) => Promise<void> }).eventHandler

  transport.onEvent(async (event) => {
    // Cloud-initiated job dispatch
    if (event.eventKey === 'job:dispatch') {
      const payload = event.payload as { jobId: string; input?: JobInput }
      if (payload.jobId) {
        ctx.logger.info({ jobId: payload.jobId }, 'Cloud-initiated job dispatch')
        await dispatcher.resumeJob(payload.jobId)
        return
      }
    }

    // Proposal apply — write file locally and git push
    if (event.eventKey === 'proposal:apply') {
      const { proposalId, files } = event.payload as {
        proposalId: string
        files: Array<{ path: string; content: string }>
      }
      ctx.logger.info({ proposalId, fileCount: files?.length }, 'Applying approved proposal')
      await applyProposal(ctx, proposalId, files)
      return
    }

    // Delegate everything else to the base dispatcher's handler
    if (originalHandler) {
      await (originalHandler as (event: unknown) => Promise<void>)(event)
    }
  })
}

/**
 * Apply an approved proposal: write files to intelligence dir, git commit + push.
 */
async function applyProposal(
  ctx: RunnerContext,
  proposalId: string,
  files: Array<{ path: string; content: string }>,
): Promise<void> {
  const { settings, gitClient, logger } = ctx
  const intelligenceDir = settings.paths.coroIntelligenceDir

  try {
    // Pull latest first to avoid conflicts
    await gitClient.pull(intelligenceDir)

    // Write files
    const fs = await import('fs')
    const path = await import('path')
    for (const file of files) {
      const fullPath = path.join(intelligenceDir, file.path)
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, file.content, 'utf-8')
    }

    // Git add + commit + push
    await gitClient.commitAll(intelligenceDir, `chore: apply proposal ${proposalId}`)
    const branch = await gitClient.currentBranch(intelligenceDir)
    await gitClient.push(intelligenceDir, branch)

    logger.info({ proposalId }, 'Proposal applied and pushed')
  } catch (err) {
    logger.error({ err, proposalId }, 'Failed to apply proposal')
  }
}
