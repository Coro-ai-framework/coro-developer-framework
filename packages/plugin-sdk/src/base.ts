// ── Plugin base classes ─────────────────────────────────────────────────────
//
// Authoring helpers that supply default implementations for the
// "boring" parts of {@link ScmPluginRuntime} / {@link TrackerPluginRuntime}.
// Plugin authors extend these to focus on the integration logic
// (cloneInfo, mcpServer, normalizeInbound, pollPr) instead of
// re-implementing the lifecycle each time.
//
// Subclasses MUST set `manifest` in their constructor and SHOULD
// override `init`/`healthcheck` to validate config and probe the
// upstream provider. The default `dispose` is a no-op which is
// correct for stateless plugins.

import type {
  ExternalRef,
  NormalizedEvent,
  PluginDeps,
  PluginHealth,
  PluginManifest,
  PluginMcpServerConfig,
  ScmCloneInfo,
  ScmPluginRuntime,
  ScmPollSnapshot,
  TrackerPluginRuntime,
} from './types'

export abstract class PluginBase {
  abstract readonly manifest: PluginManifest

  // Default lifecycle — stateless plugins can leave these alone.
  async healthcheck(): Promise<PluginHealth> {
    return { ok: true }
  }

  async dispose(): Promise<void> {
    /* override when holding resources */
  }

  intelligenceRoot(): string | undefined {
    return undefined
  }
}

/**
 * SCM plugin authoring base. Subclasses MUST implement at least
 * `init`, `cloneInfo`, `matchesRemote`, and `pollPr`. Optional
 * methods (`mcpServer`, `createPr`, `normalizeInbound`, …) can be
 * provided as needed.
 */
export abstract class ScmPluginBase<Config = unknown>
  extends PluginBase
  implements ScmPluginRuntime<Config>
{
  readonly kind = 'scm' as const
  abstract readonly manifest: PluginManifest

  abstract init(config: Config, deps: PluginDeps): Promise<void>
  abstract cloneInfo(args: { repo: string }): ScmCloneInfo
  abstract matchesRemote(remoteUrl: string): boolean
  abstract pollPr(ref: ExternalRef): Promise<ScmPollSnapshot>

  // Optional MCP descriptor — undefined by default (native-mode plugin).
  mcpServer(): PluginMcpServerConfig | undefined {
    return undefined
  }

  normalizeInbound?(req: {
    headers: Record<string, string | string[] | undefined>
    rawBody: Buffer
  }): NormalizedEvent | null
}

/**
 * Tracker plugin authoring base. Subclasses MUST implement `init`
 * and either `mcpServer` (MCP-mode) or all of
 * `getIssue`/`commentIssue`/`transitionIssue` (native-mode).
 */
export abstract class TrackerPluginBase<Config = unknown>
  extends PluginBase
  implements TrackerPluginRuntime<Config>
{
  readonly kind = 'tracker' as const
  abstract readonly manifest: PluginManifest

  abstract init(config: Config, deps: PluginDeps): Promise<void>

  mcpServer(): PluginMcpServerConfig | undefined {
    return undefined
  }

  normalizeInbound?(req: {
    headers: Record<string, string | string[] | undefined>
    rawBody: Buffer
  }): NormalizedEvent | null
}
