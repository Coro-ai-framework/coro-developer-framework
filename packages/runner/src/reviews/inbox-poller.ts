import type { Logger } from 'pino'
import type { PluginRegistry } from '../plugins/registry'
import type { ScmPluginRuntime } from '../plugins/types'
import type { ReviewPolicy } from './policy'
import type { ReviewEventSink, ReviewEventSource } from './sources'

export interface InboxStatus {
  lastPollAt?: string
  lastError?: string
  /** Open requests seen on the last successful poll, across every SCM. */
  openRequests: number
  /** SCMs in `policy.scms` that cannot list review requests. */
  unsupported: string[]
}

/**
 * Turns the SCM's "review requested from me" list into events. The list is
 * level-triggered (every poll returns every open request), so the poller
 * only reports a request the first time it sees it, or when it comes back
 * after disappearing — which is what a re-request looks like once the
 * reviewer has submitted. The first sighting after a restart is flagged so
 * the coordinator does not re-review a PR it already covered.
 */
export class InboxPoller implements ReviewEventSource {
  private timer: ReturnType<typeof setInterval> | null = null
  private sink: ReviewEventSink | null = null
  private polling: Promise<void> | null = null
  private readonly seen = new Set<string>()
  private warmedUp = false
  private readonly state: InboxStatus = { openRequests: 0, unsupported: [] }

  constructor(
    private readonly plugins: PluginRegistry,
    private readonly policy: ReviewPolicy,
    private readonly logger: Logger,
  ) {}

  start(sink: ReviewEventSink): void {
    this.sink = sink
    void this.pollNow()
    this.timer = setInterval(() => void this.pollNow(), this.policy.inboxIntervalSec * 1000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.sink = null
  }

  status(): InboxStatus {
    return { ...this.state, unsupported: [...this.state.unsupported] }
  }

  /** Runs one poll, or joins the one already in flight. */
  pollNow(): Promise<void> {
    if (!this.polling) {
      this.polling = this.poll()
        .then(() => {
          this.state.lastError = undefined
        })
        .catch(err => {
          this.state.lastError = err instanceof Error ? err.message : String(err)
          this.logger.warn({ err }, 'review inbox poll failed')
        })
        .finally(() => {
          this.state.lastPollAt = new Date().toISOString()
          this.polling = null
        })
    }
    return this.polling
  }

  private async poll(): Promise<void> {
    if (!this.sink) return
    const current = new Set<string>()
    let openRequests = 0
    const unsupported: string[] = []
    const firstSight = !this.warmedUp
    for (const pluginId of this.policy.scms) {
      const runtime = this.plugins.byId(pluginId) as ScmPluginRuntime | undefined
      if (!runtime?.listReviewRequests) {
        unsupported.push(pluginId)
        continue
      }
      const requests = await runtime.listReviewRequests({
        includeTeams: this.policy.includeTeams,
        repos: this.policy.reposInclude.length ? this.policy.reposInclude : undefined,
      })
      openRequests += requests.length
      for (const request of requests) {
        if (this.policy.reposExclude.includes(request.ref.repoKey ?? '')) continue
        if (this.policy.skipDrafts && request.draft) continue
        if (this.policy.skipAuthors.includes(request.author)) continue
        // Only qualifying requests are remembered, so a draft is reported once it is ready.
        const key = `${pluginId}:${request.ref.repoKey ?? ''}#${request.ref.externalId}`
        current.add(key)
        if (this.seen.has(key)) continue
        await this.sink?.({
          kind: 'review-requested',
          prRef: request.ref,
          actor: request.author,
          at: request.requestedAt || new Date().toISOString(),
          data: {
            title: request.title,
            url: request.url,
            author: request.author,
            draft: request.draft === true,
            ...(request.headSha ? { headSha: request.headSha } : {}),
            ...(firstSight ? { firstSight: true } : {}),
          },
          source: 'inbox-poll',
        })
      }
    }
    this.seen.clear()
    for (const key of current) this.seen.add(key)
    this.warmedUp = true
    this.state.openRequests = openRequests
    this.state.unsupported = unsupported
    this.logger.debug({ openRequests }, 'review inbox poll')
  }
}
