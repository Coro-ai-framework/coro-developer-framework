// ── Plugin conformance test pack ─────────────────────────────────────────────
//
// The bar every Coro plugin (built-in or external, v1 or v1.5) must pass.
// Each block in this file is a *contract* test parametrised across every
// built-in plugin via {@link BUILTIN_PLUGIN_FACTORIES}, so that the same
// suite is what we'd hand to a third-party plugin author.
//
// What we deliberately do NOT test here:
//   - Provider behaviour (HTTP shapes, auth flow, response decoding) —
//     that lives in plugin-specific tests; the upstream client is
//     mocked at construction time so this suite stays hermetic.
//   - End-to-end webhook routing or job dispatch — the bridge tests in
//     `tests/unit/plugin-webhook-bridge.test.ts` cover that.
//
// What we DO test here, for every plugin:
//   1. Manifest invariants (id, kind, version, displayName, hostCompat,
//      configSchema, optional webhook, optional intelligence shape).
//   2. Lifecycle (`init` validates, `healthcheck` resolves, `dispose`
//      tolerates missing init).
//   3. SCM-specific contract (clone URL shape, ExternalRef return,
//      `parseRef` rejection, `matchesRemote` consistency,
//      `normalizeInbound(<garbage>)` returns null).
//   4. Tracker-specific contract (lifecycle + `normalizeInbound` shape
//      when defined).
//   5. Intelligence contributions (when declared) point at relative
//      paths that exist under `intelligenceRoot()`.
//
// External plugin authors should run this same file against their
// runtime by importing the helpers below and calling `runConformance`.

import { describe, it, expect } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import pino from 'pino'
import {
  BUILTIN_PLUGIN_FACTORIES,
  BUILTIN_PLUGIN_IDS_BY_KIND,
  type BuiltinPluginFactory,
} from '../../src/plugins/builtin'
import {
  isScmPlugin,
  isTrackerPlugin,
  type PluginRuntime,
  type ScmPluginRuntime,
  type TrackerPluginRuntime,
  type PluginManifest,
} from '../../src/plugins'

// ── Shared fixtures ──────────────────────────────────────────────────────────

const logger = pino({ level: 'silent' })

/**
 * Per-plugin valid config used by the conformance run. Each entry is the
 * minimum config that satisfies the plugin's `configSchema`. Adding a
 * new built-in plugin means adding one entry here.
 */
const VALID_CONFIGS: Record<string, Record<string, unknown>> = {
  bitbucket: {
    workspace: 'acme',
    coderUsername: 'coder@example.com',
    coderToken: 'tok',
  },
  github: {
    owner: 'acme',
    token: 'tok',
  },
  jira: {
    baseUrl: 'https://example.atlassian.net',
    username: 'jira-user',
    apiToken: 'jira-tok',
  },
  linear: {
    apiKey: 'linear-key',
  },
  'github-issues': {
    token: 'tok',
    defaultOwner: 'acme',
  },
  local: {},
}

/**
 * Minimum invalid configs (missing required fields) — used to assert
 * that every plugin's `init` rejects malformed input via Zod.
 */
const INVALID_CONFIGS: Record<string, Record<string, unknown>> = {
  bitbucket: { workspace: 'acme' },          // missing coderUsername / coderToken
  github: { owner: 'acme' },                 // missing token
  jira: { baseUrl: 'https://example.atlassian.net' }, // missing creds
  linear: {},                                // missing apiKey
  'github-issues': { token: 't' },           // missing defaultOwner
  local: {},
}

interface ConformanceCase {
  id: string
  factory: BuiltinPluginFactory
  validConfig: Record<string, unknown>
  invalidConfig: Record<string, unknown>
}

/**
 * The conformance pack only covers SCM + tracker plugins, whose
 * factories are synchronous. We narrow the union return type once
 * here so every call site below stays clean.
 */
function syncCall(
  factory: BuiltinPluginFactory,
  config: Record<string, unknown>,
): PluginRuntime {
  return factory({ config, logger }) as PluginRuntime
}

const CASES: ConformanceCase[] = Object.entries(BUILTIN_PLUGIN_FACTORIES)
  // Executor plugins have async factories that require runner Settings
  // to instantiate (e.g. Anthropic injects bitbucket/github env into
  // the agent process). They get their own conformance suite; this
  // pack is scoped to SCM + tracker built-ins.
  .filter(([id]) => !BUILTIN_PLUGIN_IDS_BY_KIND.executor.includes(id))
  .map(([id, factory]) => {
  const validConfig = VALID_CONFIGS[id]
  const invalidConfig = INVALID_CONFIGS[id]
  if (!validConfig || !invalidConfig) {
    throw new Error(
      `conformance suite missing config fixtures for built-in plugin "${id}". ` +
      `Add a row to VALID_CONFIGS and INVALID_CONFIGS in tests/plugins/conformance.test.ts.`,
    )
  }
  return { id, factory, validConfig, invalidConfig }
})

// ── Manifest invariants ──────────────────────────────────────────────────────

describe.each(CASES)('plugin manifest — $id', ({ factory, validConfig }) => {
  const runtime: PluginRuntime = syncCall(factory, validConfig)
  const m = runtime.manifest

  it('exposes a non-empty id, version, and displayName', () => {
    expect(m.id).toBeTruthy()
    expect(m.version).toMatch(/^\d+\.\d+\.\d+/) // permissive semver-ish
    expect(m.displayName).toBeTruthy()
  })

  it('declares a known plugin kind', () => {
    expect(['scm', 'tracker']).toContain(m.kind)
  })

  it('declares a hostCompatibility range', () => {
    expect(typeof m.hostCompatibility).toBe('string')
    expect(m.hostCompatibility.length).toBeGreaterThan(0)
  })

  it('exposes a Zod-shaped configSchema', () => {
    // We don't import ZodTypeAny at runtime; duck-type instead.
    const schema = m.configSchema as unknown as { parse?: unknown; safeParse?: unknown }
    expect(typeof schema.parse).toBe('function')
    expect(typeof schema.safeParse).toBe('function')
  })

  it('matches the static BUILTIN_PLUGIN_IDS_BY_KIND index', () => {
    // The CLI uses BUILTIN_PLUGIN_IDS_BY_KIND for validation without
    // instantiating plugins. Drift between the manifest's kind and that
    // index is a footgun: the CLI would happily accept --scm=jira if
    // we let them disagree.
    const ids = BUILTIN_PLUGIN_IDS_BY_KIND[m.kind as 'scm' | 'tracker'] ?? []
    expect(ids).toContain(m.id)
  })

  it('webhook descriptor (when present) is internally consistent', () => {
    if (!m.webhook) return
    const w = m.webhook
    expect(['hmac-sha256', 'hmac-sha1', 'none']).toContain(w.algorithm)
    expect(w.header).toBeTruthy()
    expect(['sha256=<hex>', 'sha1=<hex>', '<hex>', '<plain>']).toContain(w.format)
    if (w.algorithm === 'hmac-sha256') expect(w.format).toBe('sha256=<hex>')
    if (w.algorithm === 'hmac-sha1') expect(w.format).toBe('sha1=<hex>')
  })

  it('intelligence contributions (when declared) reference relative paths', () => {
    if (!m.intelligence) return
    for (const c of m.intelligence.snippets ?? []) {
      expect(c.id).toBeTruthy()
      expect(path.isAbsolute(c.relativePath)).toBe(false)
    }
    for (const c of m.intelligence.skills ?? []) {
      expect(c.id).toBeTruthy()
      expect(path.isAbsolute(c.relativePath)).toBe(false)
    }
  })
})

// ── Lifecycle ────────────────────────────────────────────────────────────────

describe.each(CASES)('plugin lifecycle — $id', (kase) => {
  it('init() rejects malformed config', async () => {
    if (kase.id === 'local') return
    const runtime = syncCall(kase.factory, kase.invalidConfig)
    await expect(
      runtime.init(kase.invalidConfig as never, { logger, fetch: globalThis.fetch }),
    ).rejects.toThrow()
  })

  it('init() accepts valid config and healthcheck() resolves', async () => {
    const runtime = syncCall(kase.factory, kase.validConfig)
    await runtime.init(kase.validConfig as never, { logger, fetch: globalThis.fetch })
    const health = await runtime.healthcheck()
    // Some plugins return `{ ok: false, reason: '...' }` when their
    // upstream client refuses to talk without a real token. That's
    // valid — the contract is "returns a PluginHealth", not "ok".
    expect(typeof health.ok).toBe('boolean')
    if (!health.ok) expect(typeof health.reason === 'string' || health.reason === undefined).toBe(true)
  })

  it('dispose() resolves cleanly even after init', async () => {
    const runtime = syncCall(kase.factory, kase.validConfig)
    await runtime.init(kase.validConfig as never, { logger, fetch: globalThis.fetch })
    await expect(runtime.dispose()).resolves.toBeUndefined()
  })

  it('intelligenceRoot() (when implemented) points at an existing directory', () => {
    const runtime = syncCall(kase.factory, kase.validConfig)
    if (typeof runtime.intelligenceRoot !== 'function') return
    const root = runtime.intelligenceRoot()
    if (!root) return
    expect(path.isAbsolute(root)).toBe(true)
    // Source-tree path: the same module __dirname the runtime exposes.
    // We tolerate the dir not yet existing (fresh checkout) but if it
    // does, every declared snippet/skill must resolve under it.
    if (!fs.existsSync(root)) return
    const m = runtime.manifest
    for (const c of m.intelligence?.snippets ?? []) {
      const p = path.join(root, c.relativePath)
      expect(fs.existsSync(p)).toBe(true)
    }
    for (const c of m.intelligence?.skills ?? []) {
      const p = path.join(root, c.relativePath)
      expect(fs.existsSync(p)).toBe(true)
    }
  })
})

// ── SCM-specific contract ────────────────────────────────────────────────────

const SCM_CASES = CASES.filter(c => {
  if (c.id === 'local') return false
  const r = syncCall(c.factory, c.validConfig)
  return isScmPlugin(r)
})

describe.each(SCM_CASES)('SCM plugin contract — $id', (kase) => {
  async function init(): Promise<ScmPluginRuntime> {
    const runtime = syncCall(kase.factory, kase.validConfig) as ScmPluginRuntime
    await runtime.init(kase.validConfig as never, { logger, fetch: globalThis.fetch })
    return runtime
  }

  it('cloneInfo() returns a non-empty URL and an envForGit object', async () => {
    const r = await init()
    const info = r.cloneInfo({ repo: kase.id === 'local' ? process.cwd() : 'test-repo' })
    if (kase.id === 'local') {
      expect(path.isAbsolute(info.url)).toBe(true)
    } else {
      expect(info.url).toMatch(/^https?:\/\//)
    }
    expect(typeof info.envForGit).toBe('object')
    expect(info.envForGit).not.toBeNull()
  })

  it('cloneInfo() URL embeds the repo slug verbatim', async () => {
    if (kase.id === 'local') return
    const r = await init()
    const info = r.cloneInfo({ repo: 'svc-abc' })
    expect(info.url).toContain('svc-abc')
  })

  it('matchesRemote() is consistent: same URL → same answer', async () => {
    const r = await init()
    const url = r.cloneInfo({ repo: 'svc-abc' }).url
    expect(r.matchesRemote(url)).toBe(r.matchesRemote(url))
    // The URL the plugin itself produced must be one it claims as its
    // own — otherwise `intelligence/writer.ts` would fail to route a
    // self-improvement PR back through the same plugin.
    expect(r.matchesRemote(url)).toBe(true)
  })

  it('matchesRemote() is false for an obviously foreign host', async () => {
    const r = await init()
    expect(r.matchesRemote('https://invalid.example.com/x/y.git')).toBe(false)
  })

  it('normalizeInbound() returns null for malformed JSON bodies', async () => {
    const r = await init()
    const event = r.normalizeInbound({
      headers: {},
      rawBody: Buffer.from('not json'),
    })
    expect(event).toBeNull()
  })

  it('normalizeInbound() returns null for irrelevant payload shapes', async () => {
    const r = await init()
    const event = r.normalizeInbound({
      headers: {},
      rawBody: Buffer.from(JSON.stringify({ ping: true })),
    })
    expect(event).toBeNull()
  })

  it('normalizeInbound(<pull request shape>) yields ExternalRef with pluginId === manifest.id and repoKey set', async () => {
    const r = await init()
    // We construct a minimal payload that *every* SCM plugin's
    // normalizer should recognise as a pull-request event. Plugins that
    // reject this specific shape may opt out by returning null — we
    // skip the assertion for those rather than fail the contract.
    const payload = {
      // BitBucket-style
      pullrequest: {
        id: 42,
        links: { html: { href: 'https://example.org/pr/42' } },
      },
      // GitHub-style
      pull_request: {
        number: 42,
        html_url: 'https://example.org/pr/42',
      },
      repository: {
        name: 'svc-abc',
        full_name: 'acme/svc-abc',
      },
      action: 'opened',
    }
    const headers = {
      'x-event-key': 'pullrequest:created',
      'x-github-event': 'pull_request',
    }
    const event = r.normalizeInbound({
      headers,
      rawBody: Buffer.from(JSON.stringify(payload)),
    })
    if (!event) return
    expect(event.ref.kind).toBe('pull_request')
    expect(event.ref.pluginId).toBe(r.manifest.id)
    expect(event.ref.externalId).toBe('42')
    expect(event.ref.repoKey).toBeTruthy()
    expect(typeof event.kind).toBe('string')
    expect(event.kind.startsWith('pr.')).toBe(true)
  })

  it('rejects ExternalRefs owned by another plugin', async () => {
    const r = await init()
    const foreignRef = {
      kind: 'pull_request' as const,
      pluginId: 'foreign-plugin',
      repoKey: 'acme/svc-abc',
      externalId: '42',
    }
    // After the MCP-first pivot, `getPrStatus` is optional — plugins
    // serving the operation through their MCP server omit it. We use
    // `pollPr` for the negative path here because it stays required
    // (it runs outside `query()`, has no MCP equivalent).
    await expect(r.pollPr(foreignRef)).rejects.toThrow(/foreign-plugin|owned/i)
  })

  it('rejects pull_request ExternalRefs with no repoKey', async () => {
    const r = await init()
    const refWithoutRepo = {
      kind: 'pull_request' as const,
      pluginId: r.manifest.id,
      externalId: '42',
    }
    await expect(r.pollPr(refWithoutRepo)).rejects.toThrow(/repoKey/i)
  })
})

// ── Tracker-specific contract ────────────────────────────────────────────────

const TRACKER_CASES = CASES.filter(c => {
  const r = syncCall(c.factory, c.validConfig)
  return isTrackerPlugin(r)
})

describe.each(TRACKER_CASES)('Tracker plugin contract — $id', (kase) => {
  async function init(): Promise<TrackerPluginRuntime> {
    const runtime = syncCall(kase.factory, kase.validConfig) as TrackerPluginRuntime
    await runtime.init(kase.validConfig as never, { logger, fetch: globalThis.fetch })
    return runtime
  }

  it('declares mcpServer() OR exposes native getIssue/commentIssue/transitionIssue', async () => {
    // After the MCP-first pivot (S2/S6) tracker plugins are split:
    //   - **MCP-mode** plugins (`jira`, `linear`, `github-issues`)
    //     drop the per-op methods and delegate to an upstream MCP
    //     server attached at job start. Their contract is `mcpServer()`
    //     plus the lifecycle hooks.
    //   - **Native-mode** plugins (none ship today after the cleanup,
    //     but the slot is reserved for future upstream-less providers)
    //     keep `getIssue`/`commentIssue`/`transitionIssue` and do
    //     not declare `mcpServer()`.
    // Exactly one of those two surfaces must be present so the
    // hybrid `tracker_*` proxy can dispatch the call.
    const r = await init()
    const hasMcp = typeof r.mcpServer === 'function' && r.mcpServer() !== undefined
    const hasNative =
      typeof r.getIssue === 'function' &&
      typeof r.commentIssue === 'function' &&
      typeof r.transitionIssue === 'function'
    expect(hasMcp || hasNative).toBe(true)
  })

  it('normalizeInbound() (when defined) returns null for malformed JSON', async () => {
    const r = await init()
    if (typeof r.normalizeInbound !== 'function') return
    const event = r.normalizeInbound({
      headers: {},
      rawBody: Buffer.from('not json'),
    })
    expect(event).toBeNull()
  })

  it('normalizeInbound() (when defined) returns null for unrelated payload shapes', async () => {
    const r = await init()
    if (typeof r.normalizeInbound !== 'function') return
    const event = r.normalizeInbound({
      headers: {},
      rawBody: Buffer.from(JSON.stringify({ ping: true })),
    })
    expect(event).toBeNull()
  })
})

describe('auth manifest contract', () => {
  it('oauth methods declare non-empty paths; detect methods require detectCredentials', async () => {
    for (const c of CASES) {
      const runtime = syncCall(c.factory, c.validConfig)
      const methods = runtime.manifest.auth?.methods ?? []
      for (const method of methods) {
        if (method.kind === 'oauth') {
          expect(method.startPath.length).toBeGreaterThan(0)
          expect(method.statusPath.length).toBeGreaterThan(0)
        }
        if (method.kind === 'form') {
          for (const field of method.fields) {
            expect(typeof field.key).toBe('string')
          }
        }
        if (method.kind === 'detect') {
          expect(typeof runtime.detectCredentials).toBe('function')
        }
      }
    }
  })
})

// ── Cross-plugin invariants ──────────────────────────────────────────────────

describe('cross-plugin invariants', () => {
  it('manifest ids are unique across the built-in registry', () => {
    const ids = CASES.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every built-in id appears in BUILTIN_PLUGIN_IDS_BY_KIND', () => {
    const indexed = new Set([
      ...BUILTIN_PLUGIN_IDS_BY_KIND.scm,
      ...BUILTIN_PLUGIN_IDS_BY_KIND.tracker,
    ])
    for (const c of CASES) {
      expect(indexed.has(c.id)).toBe(true)
    }
  })

  // Per the MCP-first plugins pivot (S6): when a plugin declares
  // `mcpServer()`, the descriptor must be a valid `McpServerConfig`
  // shape — otherwise the runner cannot spawn the upstream server at
  // job start. We don't actually spawn it here (that needs `npx -y …`
  // and network); we just check the structural contract.
  it('every plugin declaring mcpServer() returns a structurally valid descriptor', async () => {
    for (const c of CASES) {
      const r = syncCall(c.factory, c.validConfig)
      await r.init(c.validConfig as never, { logger, fetch: globalThis.fetch })
      if (typeof r.mcpServer !== 'function') continue
      const descriptor = r.mcpServer()
      if (!descriptor) continue
      expect(['stdio', 'http', 'sse']).toContain(descriptor.type)
      if (descriptor.type === 'stdio') {
        expect(typeof descriptor.command).toBe('string')
        expect(descriptor.command.length).toBeGreaterThan(0)
        expect(Array.isArray(descriptor.args ?? [])).toBe(true)
        if (descriptor.env) {
          for (const [k, v] of Object.entries(descriptor.env)) {
            expect(typeof k).toBe('string')
            expect(typeof v).toBe('string')
          }
        }
      } else {
        expect(typeof (descriptor as { url?: unknown }).url).toBe('string')
      }
    }
  })

  it('SCM plugins have non-overlapping matchesRemote scopes for their own clone URLs', async () => {
    // The writer's `resolveByRemote` lookup picks the first plugin that
    // claims a URL. If two SCM plugins both claim the same URL, the
    // self-improvement PR routing becomes order-dependent.
    const scmPluginsWithUrls: Array<{ id: string; url: string; runtime: ScmPluginRuntime }> = []
    for (const c of SCM_CASES) {
      const r = syncCall(c.factory, c.validConfig) as ScmPluginRuntime
      await r.init(c.validConfig as never, { logger, fetch: globalThis.fetch })
      scmPluginsWithUrls.push({ id: c.id, url: r.cloneInfo({ repo: 'svc' }).url, runtime: r })
    }
    for (const { id: ownerId, url } of scmPluginsWithUrls) {
      const claimers = scmPluginsWithUrls.filter(p => p.runtime.matchesRemote(url)).map(p => p.id)
      expect(claimers, `URL emitted by ${ownerId} is claimed by: ${claimers.join(', ')}`).toEqual([ownerId])
    }
  })
})

// ── Public helper ────────────────────────────────────────────────────────────

/**
 * Re-runnable conformance harness. External plugin authors import this
 * from `@coro-ai/runner/tests/plugins/conformance` and call it with their
 * runtime + a valid+invalid config:
 *
 *   import { runConformance } from '@coro-ai/runner/tests/plugins/conformance'
 *   runConformance({
 *     id: '@vendor/coro-scm-gitea',
 *     factory: () => createGiteaPlugin(),
 *     validConfig:   { ... },
 *     invalidConfig: { ... },
 *   })
 *
 * It re-uses the same describe blocks above by spinning up a synthetic
 * `CASES` entry. We keep this exported so external plugins can drop
 * the same suite into their CI without copy-pasting.
 */
export function runConformance(args: {
  id: string
  factory: BuiltinPluginFactory
  validConfig: Record<string, unknown>
  invalidConfig: Record<string, unknown>
}): void {
  const synthCase: ConformanceCase = {
    id: args.id,
    factory: args.factory,
    validConfig: args.validConfig,
    invalidConfig: args.invalidConfig,
  }
  // Re-run the manifest + lifecycle blocks. SCM/Tracker-specific blocks
  // are kept inside this file (above) because they require iterating
  // over the kind-filtered case list at module load. External authors
  // who need them can import `isScmPlugin` / `isTrackerPlugin` and
  // assemble their own filtered describe.each.
  describe(`external plugin conformance — ${args.id}`, () => {
    const runtime = syncCall(synthCase.factory, synthCase.validConfig)
    const m: PluginManifest = runtime.manifest

    it('manifest invariants pass', () => {
      expect(m.id).toBeTruthy()
      expect(m.version).toMatch(/^\d+\.\d+\.\d+/)
      expect(m.displayName).toBeTruthy()
      expect(['scm', 'tracker']).toContain(m.kind)
      expect(typeof m.hostCompatibility).toBe('string')
      expect(typeof (m.configSchema as { parse?: unknown }).parse).toBe('function')
    })

    it('init() rejects malformed config', async () => {
      const r = syncCall(synthCase.factory, synthCase.invalidConfig)
      await expect(
        r.init(synthCase.invalidConfig as never, { logger, fetch: globalThis.fetch }),
      ).rejects.toThrow()
    })

    it('healthcheck() returns a PluginHealth shape', async () => {
      const r = syncCall(synthCase.factory, synthCase.validConfig)
      await r.init(synthCase.validConfig as never, { logger, fetch: globalThis.fetch })
      const h = await r.healthcheck()
      expect(typeof h.ok).toBe('boolean')
    })
  })
}
