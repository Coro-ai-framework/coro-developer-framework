import type { Logger } from 'pino'
import type { PluginRegistry } from '../plugins/registry'
import type { ScmPluginRuntime } from '../plugins/types'
import type { ReviewPolicy } from './policy'
import type { ReviewEventSink, ReviewEventSource } from './sources'

export class InboxPoller implements ReviewEventSource {
  private timer: ReturnType<typeof setInterval> | null = null
  private sink: ReviewEventSink | null = null

  constructor(
    private readonly plugins: PluginRegistry,
    private readonly policy: ReviewPolicy,
    private readonly logger: Logger,
  ) {}

  start(sink: ReviewEventSink): void {
    this.sink = sink
    const tick = () => { void this.poll().catch(err => this.logger.warn({ err }, 'review inbox poll failed')) }
    tick()
    this.timer = setInterval(tick, this.policy.inboxIntervalSec * 1000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async poll(): Promise<void> {
    if (!this.sink) return
    for (const pluginId of this.policy.scms) {
      const runtime = this.plugins.byId(pluginId) as ScmPluginRuntime | undefined
      if (!runtime?.listReviewRequests) continue
      const requests = await runtime.listReviewRequests({
        includeTeams: this.policy.includeTeams,
        repos: this.policy.reposInclude.length ? this.policy.reposInclude : undefined,
      })
      this.logger.info({ pluginId, count: requests.length }, 'Review inbox poll')
      for (const request of requests) {
        if (this.policy.reposExclude.includes(request.ref.repoKey ?? '')) continue
        if (this.policy.skipDrafts && request.draft) continue
        if (this.policy.skipAuthors.includes(request.author)) continue
        await this.sink({
          kind: 'review-requested',
          prRef: request.ref,
          actor: request.author,
          at: request.requestedAt || new Date().toISOString(),
          data: { title: request.title, url: request.url, draft: request.draft === true },
          source: 'inbox-poll',
        })
      }
    }
  }
}
