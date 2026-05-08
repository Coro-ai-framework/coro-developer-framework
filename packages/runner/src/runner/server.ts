// ── Runner Local HTTP Server ──────────────────────────────────────────────────
//
// A lightweight Express server that runs on the developer's machine. It serves
// the dashboard at `/dashboard/` and exposes a REST API for CLI commands and
// the dashboard to dispatch jobs, check status, stream logs, and edit
// configuration. State is backed by either the cloud (hybrid mode) or local
// SQLite (local mode) — the server is identical in both cases.

import express, { Request, Response } from 'express'
import http from 'http'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { spawn, spawnSync } from 'child_process'
import { Logger } from 'pino'
import type { Dispatcher } from '../jobs/dispatcher'
import type { StateBackend } from '../state/backend'
import type { PluginRegistry } from '../plugins/registry'
import {
  loadLocalConfig,
  loadLocalConfigRaw,
  saveLocalConfig,
  validateLocalConfig,
  defaultConfigPath,
  detectMode,
  resolveIntelligenceDir,
  resolveWorkingDir as resolveLocalWorkingDir,
  type LocalConfig,
} from '../config/local-config'
import { z } from 'zod'
import { resolveClaudeCodeCliPath, ensureClaudeCodeCliExecutable } from '../claude-code-path'
import { createJobInput, type CreateJobRequest } from '../jobs/creation'
import { assertJobPluginRequirements } from '../jobs/plugin-preflight'
import { isStoppedStatus, type Job, type CampaignChild } from '../jobs/types'
import { resolveDashboardDist } from '../dashboard-dist'
import { ClaudeLoginManager } from './claude-login'
import { formatSseFrame } from './sse'
import { listBuiltinPluginMetadata } from '../plugins/builtin'
import { discoverWorkflows } from '../workflow-discovery'
import { buildIntelligenceCatalogue } from '../intelligence-catalogue'
import { getBaseLayerRoot } from '@coro/intelligence-base'

export interface RunnerServerOptions {
  port: number
  dispatcher: Dispatcher
  stateBackend: StateBackend
  logger: Logger
  mode?: 'hybrid' | 'local'
  /**
   * The runner's process-wide tenant. Used to scope tenant-aware
   * read endpoints (e.g. `GET /proposals`) without requiring callers
   * to know the synthesised solo-tenant id.
   */
  tenantId?: string
  /**
   * Active plugin registry — populated at bootstrap. The server's
   * `/plugins` endpoint introspects it so the dashboard can render
   * plugin lists, manifests, and config schemas without hardcoding
   * provider names.
   */
  plugins?: PluginRegistry
}

/** Mask a secret for display: show enough prefix/suffix to recognise it, hide the middle. */
function redactSecret(value: string | undefined | null): string {
  if (!value) return ''
  if (value.length <= 16) return `${value.slice(0, 2)}...${value.slice(-2)}`
  return `${value.slice(0, 12)}...${value.slice(-4)}`
}

/** The dashboard echoes redacted values back on submit; treat `...` as "unchanged". */
function isRedacted(value: unknown): boolean {
  return typeof value === 'string' && value.includes('...')
}

/**
 * Drop `undefined`-valued keys from a partial-update payload before
 * merging it into the existing config. JS spread-merge would otherwise
 * overwrite `existing.foo = 'bar'` with `undefined` when the dashboard
 * sends `{ foo: undefined }` (e.g. when a path field was left blank
 * and the user only meant to update a sibling field).
 */
function omitUndefined<T extends Record<string, unknown>>(obj: T | undefined): Partial<T> {
  if (!obj) return {}
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}

/**
 * Strip nested objects whose required fields are missing/empty.
 *
 * The dashboard sends `{ intelligence: { dir: undefined }, paths: { workingDir: undefined } }`
 * when those fields are blank. If we wrote that as-is, the next read would
 * fail zod validation and every `/config` call afterwards would 500.
 *
 * Rule: an optional sub-object should be dropped entirely if it has no
 * meaningful content. The top-level shape stays a `LocalConfig`.
 */
function pruneEmptyConfigSections(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config }

  // Intelligence: keep the block if ANY field carries a value. Drop
  // only-undefined / only-empty-string entries so the file we write is
  // round-trippable, but never throw away a `gitRemote` just because
  // `dir` is left to default.
  const intelligence = out.intelligence as { dir?: unknown; gitRemote?: unknown } | undefined
  if (intelligence) {
    const cleaned: Record<string, string> = {}
    if (typeof intelligence.dir === 'string' && intelligence.dir.length > 0) {
      cleaned['dir'] = intelligence.dir
    }
    if (typeof intelligence.gitRemote === 'string' && intelligence.gitRemote.length > 0) {
      cleaned['gitRemote'] = intelligence.gitRemote
    }
    if (Object.keys(cleaned).length === 0) delete out.intelligence
    else out.intelligence = cleaned
  }

  const paths = out.paths as { workingDir?: unknown } | undefined
  if (paths) {
    const hasWorkingDir = typeof paths.workingDir === 'string' && paths.workingDir.length > 0
    if (!hasWorkingDir) delete out.paths
  }

  const git = out.git as
    | { provider?: unknown; username?: unknown; token?: unknown; workspace?: unknown }
    | undefined
  if (git) {
    const hasProvider = typeof git.provider === 'string' && git.provider.length > 0
    const hasUsername = typeof git.username === 'string' && git.username.length > 0
    const hasToken = typeof git.token === 'string' && git.token.length > 0
    if (!hasProvider || !hasUsername || !hasToken) delete out.git
  }

  const cloud = out.cloud as { url?: unknown; token?: unknown } | undefined
  if (cloud) {
    const hasUrl = typeof cloud.url === 'string' && cloud.url.length > 0
    const hasToken = typeof cloud.token === 'string' && cloud.token.length > 0
    if (!hasUrl || !hasToken) delete out.cloud
  }

  // Tracker block: keep only the section relevant to the chosen provider
  // so we never persist stale Jira creds after the user switches to Linear
  // (and vice-versa). When provider is `none` or unset we drop the whole
  // block — the factory falls back to inference, which is what the user
  // expects when they intentionally clear the form.
  const tracker = out.tracker as
    | {
        provider?: unknown
        jira?: { baseUrl?: unknown; username?: unknown; apiToken?: unknown } | undefined
        linear?: { apiKey?: unknown; teamKey?: unknown } | undefined
      }
    | undefined
  if (tracker) {
    const provider = typeof tracker.provider === 'string' ? tracker.provider : ''
    const cleaned: Record<string, unknown> = {}
    if (provider) cleaned['provider'] = provider

    if (provider === 'jira' && tracker.jira) {
      const jira: Record<string, string> = {}
      if (typeof tracker.jira.baseUrl === 'string' && tracker.jira.baseUrl.length > 0) jira['baseUrl'] = tracker.jira.baseUrl
      if (typeof tracker.jira.username === 'string' && tracker.jira.username.length > 0) jira['username'] = tracker.jira.username
      if (typeof tracker.jira.apiToken === 'string' && tracker.jira.apiToken.length > 0) jira['apiToken'] = tracker.jira.apiToken
      if (Object.keys(jira).length > 0) cleaned['jira'] = jira
    }

    if (provider === 'linear' && tracker.linear) {
      const linear: Record<string, string> = {}
      if (typeof tracker.linear.apiKey === 'string' && tracker.linear.apiKey.length > 0) linear['apiKey'] = tracker.linear.apiKey
      if (typeof tracker.linear.teamKey === 'string' && tracker.linear.teamKey.length > 0) linear['teamKey'] = tracker.linear.teamKey
      if (Object.keys(linear).length > 0) cleaned['linear'] = linear
    }

    if (Object.keys(cleaned).length === 0 || provider === 'none') {
      delete out.tracker
    } else {
      out.tracker = cleaned
    }
  }

  return out
}

/**
 * Shell-quote a string for safe inclusion inside a POSIX `sh -c` command.
 * Wraps in single quotes and escapes any single quotes via the classic
 * `'\''` dance. Used when we build a command string for `script`'s PTY
 * shim since that tool takes a single shell string rather than argv.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Strip ANSI colour/escape sequences from captured terminal output. `claude
 * setup-token` uses Ink (React-for-terminals) which wraps values in ANSI
 * colour codes, so a naive line-start match for `sk-ant-…` will miss the
 * real token.
 */
function stripAnsi(s: string): string {
  // Matches standard CSI sequences and OSC sequences used by Ink.
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1B\][^\x07]*\x07/g, '')
}

/**
 * Pull an Anthropic OAuth token out of combined CLI output.
 *
 * The CLI uses Ink (React-for-terminals) which wraps the token in ANSI
 * colour codes and — critically — hard-wraps text at the current terminal
 * width. We set `COLUMNS=10000` in the spawn env to keep the token on a
 * single line; if that's honoured, a simple anywhere-match picks it up.
 *
 * We return the *longest* match so that if Ink re-rendered the frame
 * multiple times we still prefer the fully-printed value over any
 * in-progress render.
 */
function extractOauthToken(rawOutput: string): string | null {
  const text = stripAnsi(rawOutput)

  // Require a long token body (>= 80 chars after the prefix). Real tokens
  // are ~100+ chars; an 80-col-wrapped token would yield at most ~67 body
  // chars, so this threshold rejects truncated captures that would 401.
  const oatMatches = text.match(/sk-ant-oat\d+-[A-Za-z0-9_-]{80,}/g)
  if (oatMatches && oatMatches.length) {
    return oatMatches.reduce((a, b) => (b.length > a.length ? b : a))
  }

  const anyMatches = text.match(/sk-ant-[A-Za-z0-9_-]{80,}/g)
  if (anyMatches && anyMatches.length) {
    return anyMatches.reduce((a, b) => (b.length > a.length ? b : a))
  }

  return null
}

/**
 * Pull the first Anthropic OAuth URL out of CLI output (stdout or stderr).
 * We return it to the dashboard so the user can click through if the CLI
 * failed to open a browser automatically (common on headless machines or
 * when the runner was started from a GUI/service launcher with no $BROWSER).
 */
function extractOauthUrl(text: string): string | null {
  const match = text.match(/https:\/\/(?:[\w.-]*\.)?anthropic\.com\/[^\s"')<>]+/i)
  return match ? match[0] : null
}

/**
 * Detect whether `claude setup-token --help` supports scope flags.
 * Newer CLIs expose `--scope` or `--scopes`; older CLIs do not.
 */
function detectSetupTokenScopeFlag(cliCmd: string, cliArgs: string[], logger: Logger): '--scope' | '--scopes' | null {
  try {
    const help = spawnSync(cliCmd, [...cliArgs, '--help'], {
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      encoding: 'utf-8',
      timeout: 5_000,
    })
    const text = `${help.stdout ?? ''}\n${help.stderr ?? ''}`
    if (/\b--scope\b/.test(text)) return '--scope'
    if (/\b--scopes\b/.test(text)) return '--scopes'
    return null
  } catch (err) {
    logger.warn({ err }, 'Could not probe setup-token --help; using legacy invocation')
    return null
  }
}

/**
 * Detect whether setup-token supports an explicit re-auth/force-refresh flag.
 * If present, we should use it so the CLI does not hand back a cached token
 * that may have narrower scopes than we now require.
 */
function detectSetupTokenForceFlag(cliCmd: string, cliArgs: string[], logger: Logger): string | null {
  try {
    const help = spawnSync(cliCmd, [...cliArgs, '--help'], {
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      encoding: 'utf-8',
      timeout: 5_000,
    })
    const text = `${help.stdout ?? ''}\n${help.stderr ?? ''}`
    const candidates = ['--force', '--reauth', '--re-auth', '--reset-auth'] as const
    for (const flag of candidates) {
      if (new RegExp(`\\b${flag.replace(/[-]/g, '\\-')}\\b`).test(text)) {
        return flag
      }
    }
    return null
  } catch (err) {
    logger.warn({ err }, 'Could not probe setup-token force flags; using default invocation')
    return null
  }
}

/**
 * Hydrate a campaign job's `campaignChildren[]` with a small summary of
 * each dispatched child Job. Inline so the dashboard's campaign view can
 * render phase / status / token totals / PR links without N additional
 * round-trips. Children that have not been dispatched yet (`jobId`
 * missing) or whose Job has been pruned are returned with `summary: null`.
 *
 * Keep this projection narrow — `Job` carries logs, work-item history,
 * insights, etc. that the campaign overview doesn't need. Returning the
 * full child Job here would dwarf the parent's payload.
 */
async function enrichCampaignChildren(stateBackend: StateBackend, job: Job): Promise<Job & {
  campaignChildren: (CampaignChild & {
    summary: {
      jobId: string
      type: string
      status: string
      phase: string
      workflowPath: string
      tokenUsage: Job['tokenUsage']
      prMappings: Job['prMappings']
      createdAt: string
      updatedAt: string
    } | null
  })[]
}> {
  const children = job.campaignChildren ?? []
  const enriched = await Promise.all(children.map(async child => {
    if (!child.jobId) return { ...child, summary: null }
    try {
      const childJob = await stateBackend.getJob(child.jobId)
      if (!childJob) return { ...child, summary: null }
      return {
        ...child,
        summary: {
          jobId: childJob.id,
          type: childJob.type,
          status: childJob.status,
          phase: childJob.phase,
          workflowPath: childJob.workflowPath,
          tokenUsage: childJob.tokenUsage,
          prMappings: childJob.prMappings,
          createdAt: childJob.createdAt,
          updatedAt: childJob.updatedAt,
        },
      }
    } catch {
      return { ...child, summary: null }
    }
  }))
  return { ...job, campaignChildren: enriched } as Job & {
    campaignChildren: (CampaignChild & {
      summary: {
        jobId: string
        type: string
        status: string
        phase: string
        workflowPath: string
        tokenUsage: Job['tokenUsage']
        prMappings: Job['prMappings']
        createdAt: string
        updatedAt: string
      } | null
    })[]
  }
}

/** Best-effort MIME type inference for the artefact-content endpoint. */
function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.md':   return 'text/markdown; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.txt':  return 'text/plain; charset=utf-8'
    case '.html': return 'text/html; charset=utf-8'
    case '.yml':
    case '.yaml': return 'text/yaml; charset=utf-8'
    default:      return 'text/plain; charset=utf-8'
  }
}

/**
 * Create and start the runner's local HTTP server.
 * CLI commands (`coro job`, `coro status`, etc.) talk to this.
 */
export function createRunnerServer(opts: RunnerServerOptions): http.Server {
  const { port, dispatcher, stateBackend, logger, mode = 'hybrid', tenantId, plugins } = opts
  const app = express()
  app.use(express.json())
  const claudeLoginManager = new ClaudeLoginManager({ logger })

  function saveClaudeLoginConfig(account?: {
    email?: string
    organization?: string
    subscriptionType?: string
    tokenSource?: string
    apiKeySource?: string
    apiProvider?: 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'anthropicAws' | 'mantle'
  }) {
    const existing = loadLocalConfig() ?? { anthropic: { method: 'apiKey' as const, apiKey: '' } }
    saveLocalConfig({
      ...existing,
      anthropic: {
        method: 'claudeLogin',
        account,
      },
    })
  }

  // ── Health ──────────────────────────────────────────────────────────────

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', mode, version: '0.1.0' })
  })

  // ── System helpers ──────────────────────────────────────────────────────
  //
  // Open a path in the OS-native file manager (Finder / Explorer /
  // xdg-open). The dashboard uses this for the "reveal" buttons on
  // configured paths in Settings → Paths. Path is resolved against
  // `~` and validated against an allowlist of safe roots so the
  // browser cannot ask the runner to reveal arbitrary filesystem
  // locations (e.g. `/etc`).
  app.post('/system/reveal', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { path?: unknown; create?: unknown }
      if (typeof body.path !== 'string' || body.path.trim().length === 0) {
        res.status(400).json({ ok: false, error: '`path` is required' })
        return
      }

      const expanded = body.path.startsWith('~')
        ? path.join(os.homedir(), body.path.slice(1))
        : body.path
      const resolved = path.resolve(expanded)

      // Allowlist: must sit under the user's home directory or under
      // the resolved intelligence/working dirs. Prevents drive-by
      // requests for `/etc`, `/var/db/...`, etc.
      const config = loadLocalConfig()
      const allowedRoots = [
        os.homedir(),
        resolveIntelligenceDir(config),
        resolveLocalWorkingDir(config),
        defaultConfigPath(),
      ]
      const ok = allowedRoots.some(root => {
        const r = path.resolve(root)
        return resolved === r || resolved.startsWith(r + path.sep)
      })
      if (!ok) {
        res.status(400).json({ ok: false, error: 'Path is outside allowed roots' })
        return
      }

      // Auto-create the directory on demand. The defaults (e.g.
      // `~/.coro/working`) won't exist on a fresh install until the
      // first job runs — without this, "Open folder" would 404.
      if (body.create !== false) {
        try {
          fs.mkdirSync(resolved, { recursive: true })
        } catch {
          // Continue; the open command will surface the real error if
          // the path truly doesn't exist.
        }
      }

      if (!fs.existsSync(resolved)) {
        res.status(404).json({ ok: false, error: `Path does not exist: ${resolved}` })
        return
      }

      // Spawn the platform-native opener. We detach + ignore stdio so
      // the child is fully decoupled from the runner process — the
      // file manager keeps running after the request returns.
      let cmd: string
      let args: string[]
      if (process.platform === 'darwin') {
        cmd = 'open'
        args = [resolved]
      } else if (process.platform === 'win32') {
        cmd = 'explorer.exe'
        // explorer returns exit code 1 on success — we don't wait for it.
        args = [resolved]
      } else {
        cmd = 'xdg-open'
        args = [resolved]
      }
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
      child.on('error', err => logger.warn({ err, cmd, resolved }, 'Failed to spawn file manager'))
      child.unref()

      res.json({ ok: true, path: resolved })
    } catch (err) {
      logger.warn({ err }, 'POST /system/reveal failed')
      res.status(500).json({ ok: false, error: (err as Error).message })
    }
  })

  // ── Plugins ─────────────────────────────────────────────────────────────
  //
  // Provider-neutral introspection endpoint the dashboard uses to render
  // plugin lists, defaults, and config forms. Returns a JSON-friendly
  // view of every installed plugin's manifest + its current install
  // entry from `PluginsConfig`. Secrets in `installed[id].config` are
  // not redacted here because the runner never persists raw plugin
  // config back through this endpoint — `PUT /config` (legacy) is the
  // write path for v1; the plugin-aware writer arrives in P9.

  // ── Intelligence ─────────────────────────────────────────────────────────
  //
  // Inventory of every artefact the runner can see across the layered
  // intelligence stack. Drives the dashboard's Intelligence page so the
  // user can answer "what do I have, where did it come from, and what
  // would I edit to override it" without grepping the filesystem.
  //
  // Read-only in this phase. Edits land in a later milestone.
  app.get('/intelligence/layers', async (_req: Request, res: Response) => {
    try {
      const config = loadLocalConfig()
      const tenantRoot = resolveIntelligenceDir(config)
      const baseRoot = getBaseLayerRoot()
      const catalogue = await buildIntelligenceCatalogue(
        [
          { layer: 'tenant', root: tenantRoot },
          { layer: 'base', root: baseRoot },
        ],
        logger,
      )
      res.json(catalogue)
    } catch (err) {
      logger.error({ err }, 'GET /intelligence/layers failed')
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // ── Intelligence file inspector ─────────────────────────────────────────
  //
  // Returns the raw contents of a single intelligence file along with the
  // next-lower layer's copy (when one exists) so the dashboard can render
  // a Source view and a Diff view without a second round-trip.
  //
  // Path traversal is rejected up front: only relative paths under one of
  // the four well-known artefact roots (workflows/, agents/, .claude/skills/,
  // memory/) are accepted, and any path containing `..` is rejected.
  app.get('/intelligence/file', async (req: Request, res: Response): Promise<void> => {
    const layerParam = String(req.query.layer ?? '')
    const pathParam = String(req.query.path ?? '')

    if (layerParam !== 'base' && layerParam !== 'tenant' && layerParam !== 'repo') {
      res.status(400).json({ error: 'layer must be one of base|tenant|repo' })
      return
    }
    if (!pathParam) {
      res.status(400).json({ error: 'path is required' })
      return
    }
    if (pathParam.includes('..') || pathParam.startsWith('/')) {
      res.status(400).json({ error: 'path must be relative and may not contain ..' })
      return
    }
    const allowedPrefixes = ['workflows/', 'agents/', '.claude/skills/', 'memory/']
    if (!allowedPrefixes.some(p => pathParam.startsWith(p))) {
      res.status(400).json({ error: `path must start with one of: ${allowedPrefixes.join(', ')}` })
      return
    }

    try {
      const config = loadLocalConfig()
      const tenantRoot = resolveIntelligenceDir(config)
      const baseRoot = getBaseLayerRoot()

      // Layer order matters for "lower layer" lookup: lower-priority comes
      // after higher-priority. Repo not yet wired (no working repo here).
      const layerStack: { layer: 'tenant' | 'base'; root: string }[] = [
        { layer: 'tenant', root: tenantRoot },
        { layer: 'base', root: baseRoot },
      ]

      async function readAt(layer: string): Promise<string | null> {
        const entry = layerStack.find(l => l.layer === layer)
        if (!entry) return null
        try {
          return await fs.promises.readFile(path.join(entry.root, pathParam), 'utf-8')
        } catch {
          return null
        }
      }

      const content = await readAt(layerParam)
      if (content === null) {
        res.status(404).json({ error: `File not found in ${layerParam} layer` })
        return
      }

      // Walk lower-priority layers in order; first hit wins.
      let lowerContent: string | null = null
      let lowerLayerResolved: string | null = null
      const startIdx = layerStack.findIndex(l => l.layer === layerParam)
      for (const l of layerStack.slice(startIdx + 1)) {
        const c = await readAt(l.layer)
        if (c !== null) {
          lowerContent = c
          lowerLayerResolved = l.layer
          break
        }
      }

      res.json({
        layer: layerParam,
        path: pathParam,
        content,
        lowerLayer: lowerLayerResolved,
        lowerContent,
      })
    } catch (err) {
      logger.error({ err }, 'GET /intelligence/file failed')
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // ── Workflows ───────────────────────────────────────────────────────────
  //
  // Enumerate every workflow.md the runner can dispatch against,
  // walking the layered intelligence stack (tenant overlay first,
  // then the base layer that ships with @coro/intelligence-base).
  // The dashboard's new-run page uses this to populate its workflow
  // picker, so dropping a new `workflows/<my-flow>/workflow.md` into
  // the tenant overlay surfaces it without any code change.
  //
  // Optional `?kind=job|campaign|internal` filters the result. Without
  // a filter every discovered workflow is returned — the dashboard
  // typically asks for `kind=job`.
  app.get('/workflows', async (req: Request, res: Response) => {
    try {
      const config = loadLocalConfig()
      const tenantRoot = resolveIntelligenceDir(config)
      const baseRoot = getBaseLayerRoot()
      // Order = priority: tenant overrides base. Repo overlay is not
      // available outside a job context, so it is intentionally absent
      // here \u2014 the new-run page only shows base/tenant workflows.
      const all = await discoverWorkflows(
        [
          { layer: 'tenant', root: tenantRoot },
          { layer: 'base', root: baseRoot },
        ],
        logger,
      )
      const kindFilter = typeof req.query['kind'] === 'string' ? req.query['kind'] : undefined
      const workflows = kindFilter ? all.filter(w => w.kind === kindFilter) : all
      res.json({ workflows })
    } catch (err) {
      logger.error({ err }, 'GET /workflows failed')
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.get('/plugins', async (_req: Request, res: Response) => {
    try {
      const config = loadLocalConfig()
      const { resolvePluginsConfig } = await import('../config/local-config')
      const resolved = resolvePluginsConfig(config)

      const dropinIds = listDropinPluginIds()
      const builtinMetadata = listBuiltinPluginMetadata(logger)
      const builtinById = new Map(builtinMetadata.map(entry => [entry.manifest.id, entry]))

      const runtimes = plugins?.all() ?? []
      const runtimesById = new Map(runtimes.map(runtime => [runtime.manifest.id, runtime]))
      const pluginIds = new Set<string>([
        ...builtinById.keys(),
        ...runtimesById.keys(),
      ])

      const manifests = Array.from(pluginIds).map(id => {
        const runtime = runtimesById.get(id)
        const builtin = builtinById.get(id)
        const m = runtime?.manifest ?? builtin?.manifest
        if (!m) return null
        // zod 4 exposes .toJSONSchema() / z.toJSONSchema(); older zod
        // versions don't. We swallow the throw so the dashboard at
        // least gets the manifest header even when JSON-schema
        // serialisation is unavailable.
        let configSchemaJson: unknown = null
        try {
          // Available in zod 4. Older zod versions don't ship this helper —
          // swallow so the dashboard still gets the manifest header.
          const toJSONSchema = (z as unknown as { toJSONSchema?: (s: unknown) => unknown }).toJSONSchema
          if (typeof toJSONSchema === 'function') {
            configSchemaJson = toJSONSchema(m.configSchema)
          }
        } catch {
          configSchemaJson = null
        }
        // Surface plugin-provided MCP server descriptors (S1 of the
        // MCP-first pivot) so operators can see exactly which upstream
        // servers will be attached to job sessions. Secrets in
        // env / headers are redacted — the dashboard only needs the
        // shape, not the credentials.
        let mcpServer: unknown = null
        if (runtime && typeof runtime.mcpServer === 'function') {
          try {
            const desc = runtime.mcpServer()
            if (desc) mcpServer = redactPluginMcpServer(desc)
          } catch (err) {
            logger.warn({ err, pluginId: m.id }, 'Plugin mcpServer() threw during /plugins enumeration')
          }
        }

        const configured = resolved.installed[m.id]?.enabled ?? false
        const active = runtimesById.has(m.id)

        return {
          manifest: {
            id: m.id,
            kind: m.kind,
            version: m.version,
            displayName: m.displayName,
            hostCompatibility: m.hostCompatibility,
            capabilities: m.capabilities ?? {},
            ...(m.webhook ? {
              webhook: {
                pathSuffix: m.webhook.pathSuffix,
                algorithm: m.webhook.algorithm,
                header: m.webhook.header,
                format: m.webhook.format,
              },
            } : {}),
            configSchema: configSchemaJson,
          },
          installed: configured,
          configured,
          active,
          available: true,
          // Tells the dashboard whether the user can call `DELETE
          // /plugins/:id` on this entry. Built-in plugins ship with
          // the runner and can't be removed at runtime.
          source: builtinById.has(m.id) ? ('builtin' as const) : ('dropin' as const),
          activationHint:
            builtin?.activationHint
            ?? (dropinIds.has(m.id)
              ? 'Drop-in plugin detected on disk. Add it to the plugins config to enable it for jobs.'
              : undefined),
          mcpServer,
        }
      }).filter((entry): entry is NonNullable<typeof entry> => entry !== null)

      res.json({
        plugins: manifests,
        defaults: resolved.defaults ?? {},
        // Cloud webhook registration URL helper for the dashboard's
        // "copy this URL into <provider>" action. Empty when running
        // in pure local mode.
        webhookBaseUrl:
          mode === 'hybrid' && config?.cloud?.url
            ? `${config.cloud.url.replace(/\/$/, '')}/webhook`
            : null,
      })
    } catch (err) {
      logger.error({ err }, 'GET /plugins failed')
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /plugins/install — drop-in install via npm spec. Wraps the
  // CLI flow (`coro plugin install …`) in an HTTP endpoint so the
  // dashboard's "Install plugin" form can spawn the same install
  // pipeline without shelling out client-side. The runner reloads
  // its plugin registry by re-bootstrapping on the next job; the
  // response includes a `restartHint` flag the dashboard surfaces
  // verbatim.
  app.post('/plugins/install', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { spec?: unknown; id?: unknown }
      if (typeof body.spec !== 'string' || body.spec.length === 0) {
        res.status(400).json({ error: '`spec` (npm package spec) is required' })
        return
      }
      const explicitId = typeof body.id === 'string' && body.id.length > 0 ? body.id : undefined
      const result = await installDropinPlugin({ spec: body.spec, id: explicitId, logger })
      res.json({
        ok: true,
        installedAt: result.pluginDir,
        manifest: result.manifest,
        restartHint:
          'Plugin installed. Restart the runner (`coro start`) so the new ' +
          'plugin is loaded into the registry — running jobs continue with ' +
          'the previous registry until you restart.',
      })
    } catch (err) {
      logger.error({ err }, 'POST /plugins/install failed')
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.delete('/plugins/:id', async (req: Request, res: Response) => {
    try {
      const rawId = req.params['id']
      const id = typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] : undefined
      if (!id || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
        res.status(400).json({ error: 'Invalid plugin id' })
        return
      }
      const removed = await uninstallDropinPlugin({ id, logger })
      if (!removed) {
        res.status(404).json({ error: `No drop-in plugin installed under id "${id}"` })
        return
      }
      res.json({
        ok: true,
        removedAt: removed,
        restartHint:
          'Plugin removed from disk. Restart the runner so the in-memory ' +
          'registry stops attaching it to new job sessions.',
      })
    } catch (err) {
      logger.error({ err }, 'DELETE /plugins/:id failed')
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // ── Job dispatch ────────────────────────────────────────────────────────

  app.post('/jobs', async (req: Request, res: Response) => {
    try {
      const body = req.body as Partial<CreateJobRequest>
      if (typeof body?.workflowPath !== 'string' || !body.workflowPath.trim()) {
        res.status(400).json({ error: 'workflowPath is required' })
        return
      }

      const input = createJobInput(body as CreateJobRequest)
      if (plugins) {
        assertJobPluginRequirements(input, plugins)
      }
      const job = await dispatcher.dispatch(input)
      res.status(201).json({
        jobId: job.id,
        type: job.type,
        status: job.status,
        streamUrl: `/jobs/${job.id}/stream`,
      })
    } catch (err) {
      logger.error({ err }, 'Generic job dispatch failed')
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // ── Job CRUD ────────────────────────────────────────────────────────────

  app.get('/jobs', async (req: Request, res: Response) => {
    try {
      const parentId = typeof req.query.campaignParentId === 'string' && req.query.campaignParentId.length > 0
        ? req.query.campaignParentId
        : null
      if (parentId) {
        // Filter to children of a single campaign. The state backend has
        // a tailored query (Postgres uses an indexed lookup; SQLite/Redis
        // scan + filter) so the dashboard's campaign view doesn't have to
        // rehydrate every job in the system.
        const children = await stateBackend.listChildJobs(parentId)
        res.json(children)
        return
      }
      const jobs = await stateBackend.listJobs()
      res.json(jobs)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.get('/jobs/:jobId', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const job = await stateBackend.getJob(jobId)
      if (!job) { res.status(404).json({ error: 'Job not found' }); return }
      // For campaign parent jobs, enrich each registered child's entry
      // with a cheap summary of the dispatched child Job (phase, status,
      // tokens, PRs). Saves the dashboard a fan-out when rendering the
      // campaign detail page. Non-campaign jobs return unchanged.
      if (Array.isArray(job.campaignChildren) && job.campaignChildren.length > 0) {
        const enriched = await enrichCampaignChildren(stateBackend, job)
        res.json(enriched)
        return
      }
      res.json(job)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // ── Campaign child mutations ────────────────────────────────────────────
  //
  // Live-control endpoints forwarded to the dispatcher's coordinator. Each
  // mutates `campaignChildren[]` on the parent (skip / reset / cancel),
  // re-runs the coordinator sweep, and optionally interrupts the underlying
  // child Job. They are POSTs (not PATCHes) because the dispatcher may
  // dispatch new children as a side effect — the result is not idempotent
  // in the request-replay sense.

  app.post('/jobs/:jobId/children/:name/skip', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const name = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined
      await dispatcher.campaignSkipChild(jobId, name, reason)
      res.json({ ok: true, action: 'skip', child: name })
    } catch (err) {
      const msg = (err as Error).message
      const code = /not found/i.test(msg) ? 404 : 400
      res.status(code).json({ error: msg })
    }
  })

  app.post('/jobs/:jobId/children/:name/rerun', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const name = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined
      await dispatcher.campaignRerunChild(jobId, name, reason)
      res.json({ ok: true, action: 'rerun', child: name })
    } catch (err) {
      const msg = (err as Error).message
      const code = /not found/i.test(msg) ? 404 : 400
      res.status(code).json({ error: msg })
    }
  })

  app.post('/jobs/:jobId/children/:name/cancel', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const name = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined
      await dispatcher.campaignCancelChild(jobId, name, reason)
      res.json({ ok: true, action: 'cancel', child: name })
    } catch (err) {
      const msg = (err as Error).message
      const code = /not found/i.test(msg) ? 404 : 400
      res.status(code).json({ error: msg })
    }
  })

  // ── Artefact content ────────────────────────────────────────────────────
  // Read-only endpoint that returns the text content of an artefact whose
  // `data.path` points at a file inside the job's working directory. Used by
  // the dashboard to render `plan-md`, `report-md`, `implementation-plan-md`,
  // `analysis-contract`, etc. in a modal.
  //
  // Security: the resolved path MUST stay inside `{workingDir}/{jobId}/`.

  app.get('/jobs/:jobId/artifacts/:artifactId/content', async (req: Request, res: Response) => {
    const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
    const artifactId = Array.isArray(req.params.artifactId) ? req.params.artifactId[0] : req.params.artifactId

    try {
      const job = await stateBackend.getJob(jobId)
      if (!job) {
        res.status(404).json({ error: `Job not found: ${jobId}` })
        return
      }

      const artifact = (job.artifacts ?? []).find(a => a.id === artifactId)
      if (!artifact) {
        res.status(404).json({ error: `Artifact not found: ${artifactId}` })
        return
      }

      const rawPath = (artifact.data as Record<string, unknown> | undefined)?.['path']
      if (typeof rawPath !== 'string' || !rawPath.trim()) {
        res.status(400).json({ error: 'Artifact has no `data.path` to read' })
        return
      }

      const config = loadLocalConfig()
      const workingDir = resolveLocalWorkingDir(config)
      const jobWorkingDir = path.resolve(workingDir, jobId)
      const resolved = path.resolve(jobWorkingDir, rawPath)

      if (!resolved.startsWith(jobWorkingDir + path.sep) && resolved !== jobWorkingDir) {
        logger.warn({ jobId, artifactId, rawPath, resolved }, 'Artifact path escape attempt blocked')
        res.status(400).json({ error: 'Artifact path is outside the job working directory' })
        return
      }

      const content = await fs.promises.readFile(resolved, 'utf-8')
      res.setHeader('Content-Type', mimeForPath(resolved))
      res.send(content)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      res.status(404).json({ error: `Could not read artifact content: ${msg}` })
    }
  })

  // ── Log streaming (SSE) ─────────────────────────────────────────────────

  app.get('/jobs/:jobId/stream', async (req: Request, res: Response) => {
    const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
    const job = await stateBackend.getJob(jobId)

    if (!job) {
      res.status(404).json({ error: 'Job not found' })
      return
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    // Send existing logs first
    const existingLogs = await stateBackend.getLog(jobId)
    for (const line of existingLogs) {
      res.write(formatSseFrame(line))
    }

    // Poll for new logs (simple polling — could be improved with pub/sub)
    let lastLen = existingLogs.length
    const interval = setInterval(async () => {
      try {
        const currentLen = await stateBackend.logLength(jobId)
        if (currentLen > lastLen) {
          const newLines = await stateBackend.getLog(jobId, lastLen)
          for (const line of newLines) {
            res.write(formatSseFrame(line))
          }
          lastLen = currentLen
        }

        // Check if job is done
        const currentJob = await stateBackend.getJob(jobId)
        if (currentJob && isStoppedStatus(currentJob.status)) {
          res.write(formatSseFrame(currentJob.status, 'done'))
          clearInterval(interval)
          res.end()
        }
      } catch {
        // Ignore poll errors
      }
    }, 1000)

    req.on('close', () => {
      clearInterval(interval)
    })
  })

  // ── Live job controls ───────────────────────────────────────────────────
  //
  // Toggle the `interactive` flag on a running or parked job. Going ON has
  // no immediate effect; the next workflow phase boundary that carries
  // `interactive_checkpoint: true` will park for approval. Going OFF on a
  // job currently parked at an interactive checkpoint auto-releases the
  // park and advances to the next phase.

  app.patch('/jobs/:jobId/interactive', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const body = req.body as { interactive?: unknown } | undefined
      if (typeof body?.interactive !== 'boolean') {
        res.status(400).json({ error: '`interactive` (boolean) is required in the body' })
        return
      }
      const updated = await dispatcher.setJobInteractive(jobId, body.interactive)
      res.json({
        jobId: updated.id,
        interactive: updated.interactive,
        status: updated.status,
        phase: updated.phase,
      })
    } catch (err) {
      const msg = (err as Error).message
      const code = /not found/i.test(msg) ? 404 : 400
      res.status(code).json({ error: msg })
    }
  })

  // ── Resume ──────────────────────────────────────────────────────────────

  app.post('/jobs/:jobId/resume', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const { fromPhase, clearSession } = req.body ?? {}
      await dispatcher.resumeJob(jobId, fromPhase, clearSession)
      res.json({ resumed: jobId })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  app.post('/jobs/:jobId/cancel', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined
      const updated = await dispatcher.cancelJob(jobId, reason)
      res.json({ cancelled: updated.id, status: updated.status })
    } catch (err) {
      const msg = (err as Error).message
      const code = /not found/i.test(msg) ? 404 : 400
      res.status(code).json({ error: msg })
    }
  })

  // ── Message injection ───────────────────────────────────────────────────

  app.post('/jobs/:jobId/message', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const { message } = req.body ?? {}
      if (!message) { res.status(400).json({ error: 'message is required' }); return }
      await dispatcher.sendMessage(jobId, message)
      res.json({ sent: true })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // ── Proposals (read-only) ───────────────────────────────────────────────
  //
  // The dashboard renders a read-only mirror of in-flight self-improvement
  // PRs. Approvals happen on the git provider — this endpoint just
  // exposes "what's open right now" so a developer doesn't have to dig
  // through GitHub/Bitbucket UI to see what their agents proposed.
  //
  // Tenant scoping: the runner's process-wide tenant id (passed in via
  // `RunnerServerOptions.tenantId`) is the default. Cloud/team setups can
  // override per request via `?tenantId=<id>` — useful when a single
  // dashboard surfaces multiple tenants in the future.

  app.get('/proposals', async (req: Request, res: Response) => {
    try {
      const requested = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined
      const scope = requested ?? tenantId
      if (!scope) {
        res.status(400).json({
          error: 'tenantId is not configured on this runner; pass ?tenantId=<id> to scope the query.',
        })
        return
      }
      const status = typeof req.query.status === 'string' ? req.query.status : undefined
      if (status && status !== 'pending' && status !== 'approved' && status !== 'rejected') {
        res.status(400).json({ error: `invalid status "${status}" — must be pending, approved, or rejected` })
        return
      }
      const proposals = await stateBackend.listProposals(scope, status as 'pending' | 'approved' | 'rejected' | undefined)
      res.json({
        tenantId: scope,
        count: proposals.length,
        proposals: proposals.map(p => ({
          id: p.id,
          jobId: p.jobId,
          type: p.type,
          title: p.title,
          status: p.status,
          targetLayer: p.targetLayer,
          prUrl: p.prUrl,
          branch: p.branch,
          fileCount: p.files?.length ?? 0,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })),
      })
    } catch (err) {
      logger.error({ err }, 'GET /proposals failed')
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // ── Configuration ────────────────────────────────────────────────────────

  app.get('/config', (_req: Request, res: Response) => {
    try {
      const configPath = defaultConfigPath()
      const result = loadLocalConfigRaw()

      // If the on-disk file is malformed (e.g. an older save wrote an empty
      // sub-object that the current schema rejects), surface it as data
      // rather than a 500. The dashboard can then render the offending
      // file alongside an "Invalid config — please re-save" banner instead
      // of a generic error toast.
      if (result.kind === 'invalid') {
        logger.warn(
          { configPath, error: result.error.message },
          'Local config is invalid — returning raw payload to dashboard for repair',
        )
        res.json({
          config: null,
          configPath,
          mode: 'local',
          resolved: {
            intelligenceDir: resolveIntelligenceDir(null),
            workingDir: resolveLocalWorkingDir(null),
          },
          configError: result.error.message,
          rawConfig: result.raw,
        })
        return
      }

      const config = result.kind === 'ok' ? result.config : null
      const detected = detectMode(config)

      // Redact sensitive fields for display. Both apiKey and oauthToken need
      // masking; claudeLogin stores only metadata, so that can be returned as-is.
      // We always send back the full `method` tag so the UI renders the correct
      // auth state regardless of which credential is currently active.
      const safeConfig = config ? {
        ...config,
        anthropic: {
          method: config.anthropic?.method ?? 'apiKey',
          apiKey: redactSecret(config.anthropic?.apiKey),
          oauthToken: redactSecret(config.anthropic?.oauthToken),
          account: config.anthropic?.account,
        },
        git: config.git ? {
          ...config.git,
          token: config.git.token
            ? `${config.git.token.slice(0, 6)}...${config.git.token.slice(-4)}`
            : '',
        } : undefined,
        // Tracker creds round-trip with the same `...` redaction
        // convention as anthropic + git so the dashboard can display a
        // hint that the secret is set without ever shipping it to the
        // browser. PUT /config restores the on-disk value when it sees
        // a `...`-redacted string come back.
        tracker: config.tracker ? {
          provider: config.tracker.provider,
          jira: config.tracker.jira ? {
            baseUrl: config.tracker.jira.baseUrl,
            username: config.tracker.jira.username,
            apiToken: redactSecret(config.tracker.jira.apiToken),
          } : undefined,
          linear: config.tracker.linear ? {
            apiKey: redactSecret(config.tracker.linear.apiKey),
            teamKey: config.tracker.linear.teamKey,
          } : undefined,
        } : undefined,
        // S9 toggle. Always echo (even when `false`) so the
        // dashboard can render the switch in its actual state.
        inheritClaudeCodeMcps: config.inheritClaudeCodeMcps === true,
        // BYO MCP servers (S8). env / headers values get redacted
        // so secrets never round-trip through the dashboard. PUT
        // /config restores the on-disk value when it sees `...`.
        mcpServers: config.mcpServers
          ? Object.fromEntries(
              Object.entries(config.mcpServers).map(([id, raw]) => {
                const entry: Record<string, unknown> = { ...raw }
                if (raw.type === 'stdio' && raw.env) {
                  entry['env'] = Object.fromEntries(
                    Object.entries(raw.env).map(([k, v]) => [k, redactSecret(v)]),
                  )
                }
                if ((raw.type === 'http' || raw.type === 'sse') && raw.headers) {
                  entry['headers'] = Object.fromEntries(
                    Object.entries(raw.headers).map(([k, v]) => [k, redactSecret(v)]),
                  )
                }
                return [id, entry]
              }),
            )
          : undefined,
      } : null

      // `resolved` mirrors what the runner will actually use on disk:
      // - if the user has set `paths.workingDir` / `intelligence.dir`, those win
      // - otherwise the helpers fall back to the `~/.coro/...` defaults
      // The dashboard renders these as placeholders so leaving a path field
      // blank visibly means "use this default".
      res.json({
        config: safeConfig,
        configPath,
        mode: detected,
        resolved: {
          intelligenceDir: resolveIntelligenceDir(config),
          workingDir: resolveLocalWorkingDir(config),
        },
      })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // GET /config/claude-code-mcps — preview helper for the
  // `inheritClaudeCodeMcps` toggle (S9). Returns the MCP server
  // entries the runner would discover from user-level Claude Code
  // configs, with secrets redacted. The dashboard uses this to show
  // operators exactly what the toggle inherits before they enable it.
  app.get('/config/claude-code-mcps', async (_req: Request, res: Response) => {
    try {
      const { discoverClaudeCodeMcpServers } = await import('../config/local-config')
      const { servers, sources } = discoverClaudeCodeMcpServers()
      const safe = Object.fromEntries(
        Object.entries(servers).map(([id, raw]) => {
          const entry: Record<string, unknown> = { ...raw }
          if (raw.type === 'stdio' && raw.env) {
            entry['env'] = Object.fromEntries(
              Object.entries(raw.env).map(([k, v]) => [k, redactSecret(v)]),
            )
          }
          if ((raw.type === 'http' || raw.type === 'sse') && raw.headers) {
            entry['headers'] = Object.fromEntries(
              Object.entries(raw.headers).map(([k, v]) => [k, redactSecret(v)]),
            )
          }
          return [id, entry]
        }),
      )
      res.json({ servers: safe, sources })
    } catch (err) {
      logger.error({ err }, 'GET /config/claude-code-mcps failed')
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.put('/config', (req: Request, res: Response) => {
    try {
      const updates = req.body
      if (!updates || typeof updates !== 'object') {
        res.status(400).json({ error: 'Request body must be a config object' })
        return
      }

      // Load existing, merge, save. The placeholder apiKey keeps zod's refine
      // happy when no real credential has been written yet; real writes below
      // overwrite it before save.
      //
      // We use loadLocalConfigRaw() so a previously corrupt file doesn't block
      // the save: if the on-disk JSON fails schema validation, we treat the
      // existing state as empty and let the user overwrite it cleanly.
      const existingResult = loadLocalConfigRaw()
      const existing: LocalConfig =
        existingResult.kind === 'ok'
          ? existingResult.config
          : { anthropic: { method: 'apiKey' as const, apiKey: '' } }
      const merged: LocalConfig = { ...existing }

      // Update anthropic auth. The UI sends a discriminated object with
      // `method` plus whichever field belongs to that method. We never trust
      // a redacted value ("...") — if the user hasn't changed the secret,
      // keep whatever is already on disk. When the method flips we wipe the
      // other credential so the config doesn't accumulate stale secrets.
      if (updates.anthropic) {
        const incomingMethod: 'apiKey' | 'oauth' | 'claudeLogin' =
          updates.anthropic.method === 'oauth'
            ? 'oauth'
            : updates.anthropic.method === 'claudeLogin'
              ? 'claudeLogin'
              : 'apiKey'

        if (incomingMethod === 'apiKey') {
          const nextKey = isRedacted(updates.anthropic.apiKey)
            ? existing.anthropic?.apiKey ?? ''
            : updates.anthropic.apiKey ?? existing.anthropic?.apiKey ?? ''
          merged.anthropic = { method: 'apiKey', apiKey: nextKey }
        } else if (incomingMethod === 'oauth') {
          const nextToken = isRedacted(updates.anthropic.oauthToken)
            ? existing.anthropic?.oauthToken ?? ''
            : updates.anthropic.oauthToken ?? existing.anthropic?.oauthToken ?? ''
          merged.anthropic = { method: 'oauth', oauthToken: nextToken }
        } else {
          merged.anthropic = {
            method: 'claudeLogin',
            account:
              updates.anthropic.account && typeof updates.anthropic.account === 'object'
                ? updates.anthropic.account
                : existing.anthropic?.account,
          }
        }
      }

      // Update intelligence — preserve existing fields when the dashboard
      // sends `undefined` for them (e.g. user filled in `gitRemote` only
      // and left `dir` blank to use the default).
      if (updates.intelligence) {
        merged.intelligence = {
          ...existing.intelligence,
          ...omitUndefined(updates.intelligence),
        }
      }

      // Update paths
      if (updates.paths) {
        merged.paths = {
          ...existing.paths,
          ...omitUndefined(updates.paths),
        } as LocalConfig['paths']
      }

      // Update git
      if (updates.git) {
        const cleaned = omitUndefined(updates.git)
        merged.git = {
          ...existing.git,
          ...cleaned,
          // Don't overwrite token with redacted value
          token: typeof cleaned.token === 'string' && cleaned.token.includes('...')
            ? existing.git?.token ?? ''
            : (cleaned.token as string | undefined) ?? existing.git?.token ?? '',
        } as LocalConfig['git']
      }

      // Respect local mode — strip cloud if not explicitly set
      if (!updates.cloud) {
        delete (merged as Record<string, unknown>).cloud
      }

      // Tracker block. Treat redacted secrets the same way the anthropic
      // branch does: when the dashboard echoes a `...` value back we
      // preserve whatever is already on disk. Switching providers wipes
      // the inactive credential sub-blocks on save (handled by
      // `pruneEmptyConfigSections` below) so we don't accumulate stale
      // tokens.
      if (updates.tracker) {
        const incoming = updates.tracker as {
          provider?: 'none' | 'jira' | 'github' | 'linear'
          jira?: { baseUrl?: string; username?: string; apiToken?: string }
          linear?: { apiKey?: string; teamKey?: string }
        }
        const next: NonNullable<LocalConfig['tracker']> = {}
        if (incoming.provider) next.provider = incoming.provider
        if (incoming.jira) {
          next.jira = {
            ...(incoming.jira.baseUrl !== undefined ? { baseUrl: incoming.jira.baseUrl } : {}),
            ...(incoming.jira.username !== undefined ? { username: incoming.jira.username } : {}),
            apiToken: isRedacted(incoming.jira.apiToken)
              ? existing.tracker?.jira?.apiToken
              : incoming.jira.apiToken ?? existing.tracker?.jira?.apiToken,
          }
        }
        if (incoming.linear) {
          next.linear = {
            apiKey: isRedacted(incoming.linear.apiKey)
              ? existing.tracker?.linear?.apiKey
              : incoming.linear.apiKey ?? existing.tracker?.linear?.apiKey,
            ...(incoming.linear.teamKey !== undefined ? { teamKey: incoming.linear.teamKey } : {}),
          }
        }
        merged.tracker = next
      }

      // S9: inheritClaudeCodeMcps toggle — discover user-level
      // Claude Code MCP entries and merge them into every job
      // session at attachment time. The flag is persisted as-is.
      if (Object.prototype.hasOwnProperty.call(updates, 'inheritClaudeCodeMcps')) {
        const value = (updates as Record<string, unknown>)['inheritClaudeCodeMcps']
        if (typeof value === 'boolean') {
          ;(merged as Record<string, unknown>).inheritClaudeCodeMcps = value
        }
      }

      // BYO MCP servers (S8). The dashboard sends the entire
      // `mcpServers` map back; secrets in env / headers go through
      // the same redaction-preserve dance as other credentials so a
      // round-trip GET → save doesn't write `***` to disk.
      if (Object.prototype.hasOwnProperty.call(updates, 'mcpServers')) {
        const incoming = updates.mcpServers as Record<string, Record<string, unknown>> | null | undefined
        if (incoming === null || incoming === undefined) {
          delete (merged as Record<string, unknown>).mcpServers
        } else {
          const next: Record<string, Record<string, unknown>> = {}
          for (const [id, raw] of Object.entries(incoming)) {
            if (!raw || typeof raw !== 'object') continue
            const previous = existing.mcpServers?.[id] as Record<string, unknown> | undefined
            const cleaned: Record<string, unknown> = { ...raw }
            if (raw['env'] && typeof raw['env'] === 'object') {
              const env = raw['env'] as Record<string, string>
              const prevEnv = (previous?.['env'] ?? {}) as Record<string, string>
              const nextEnv: Record<string, string> = {}
              for (const [k, v] of Object.entries(env)) {
                nextEnv[k] = isRedacted(v) ? prevEnv[k] ?? v : v
              }
              cleaned['env'] = nextEnv
            }
            if (raw['headers'] && typeof raw['headers'] === 'object') {
              const headers = raw['headers'] as Record<string, string>
              const prevHeaders = (previous?.['headers'] ?? {}) as Record<string, string>
              const nextHeaders: Record<string, string> = {}
              for (const [k, v] of Object.entries(headers)) {
                nextHeaders[k] = isRedacted(v) ? prevHeaders[k] ?? v : v
              }
              cleaned['headers'] = nextHeaders
            }
            next[id] = cleaned
          }
          ;(merged as Record<string, unknown>).mcpServers = next
        }
      }

      // Drop empty sub-objects (e.g. `{ paths: {}, intelligence: {} }`) so the
      // file we write back will round-trip through the schema on next read.
      const pruned = pruneEmptyConfigSections(merged as Record<string, unknown>)

      // Validate before writing. Fail-fast with a 400 carrying the field-level
      // zod error rather than writing garbage that would break later reads.
      const validation = validateLocalConfig(pruned)
      if (!validation.success) {
        logger.warn({ issues: validation.issues }, 'Rejecting invalid config from dashboard')
        res.status(400).json({
          error: 'Invalid configuration',
          issues: validation.issues,
        })
        return
      }

      saveLocalConfig(validation.config)
      logger.info('Configuration updated via dashboard')
      res.json({ saved: true, configPath: defaultConfigPath() })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // ── Connection tests (third-party APIs) ─────────────────────────────────
  //
  // These endpoints proxy a "ping" call to the configured third-party API
  // (git provider, issue tracker) so the dashboard never has to hold or
  // ship the raw credential. They also accept the dashboard's redacted
  // `...` token form: when the user hasn't re-entered the secret, we
  // substitute the value from disk before making the upstream call.

  /** Resolve a possibly-redacted secret from the request against on-disk config. */
  function resolveSecret(provided: unknown, onDisk: string | undefined | null): string {
    if (typeof provided !== 'string') return onDisk ?? ''
    if (provided.length === 0) return onDisk ?? ''
    if (isRedacted(provided)) return onDisk ?? ''
    return provided
  }

  /** Trim trailing slash for clean URL joins. */
  function trimSlash(url: string): string {
    return url.replace(/\/+$/, '')
  }

  app.post('/test/git', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        provider?: string
        username?: string
        token?: string
        workspace?: string
      }
      const provider = body.provider
      if (provider !== 'github' && provider !== 'bitbucket' && provider !== 'gitlab') {
        res.status(400).json({ ok: false, message: `Unsupported git provider "${provider}"` })
        return
      }

      const existing = loadLocalConfig()
      const username = (body.username ?? existing?.git?.username ?? '').trim()
      const token = resolveSecret(body.token, existing?.git?.token)
      if (!token) {
        res.json({ ok: false, message: 'Token is required.' })
        return
      }

      if (provider === 'github') {
        const r = await fetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'coro-runner',
          },
        })
        if (!r.ok) {
          const text = await r.text().catch(() => '')
          res.json({ ok: false, message: `GitHub ${r.status}: ${text.slice(0, 200) || r.statusText}` })
          return
        }
        const data = (await r.json()) as { login?: string }
        if (username && data.login && data.login.toLowerCase() !== username.toLowerCase()) {
          res.json({
            ok: false,
            message: `Token authenticated as ${data.login}, but username is set to ${username}.`,
          })
          return
        }
        res.json({ ok: true, message: `Authenticated as ${data.login ?? '(unknown)'}` })
        return
      }

      if (provider === 'bitbucket') {
        if (!username) {
          res.json({ ok: false, message: 'Bitbucket requires a username for app-password auth.' })
          return
        }
        const auth = Buffer.from(`${username}:${token}`).toString('base64')
        const r = await fetch('https://api.bitbucket.org/2.0/user', {
          headers: { Authorization: `Basic ${auth}`, 'User-Agent': 'coro-runner' },
        })
        if (!r.ok) {
          const text = await r.text().catch(() => '')
          res.json({ ok: false, message: `Bitbucket ${r.status}: ${text.slice(0, 200) || r.statusText}` })
          return
        }
        const data = (await r.json()) as { username?: string; display_name?: string }
        res.json({
          ok: true,
          message: `Authenticated as ${data.display_name ?? data.username ?? username}`,
        })
        return
      }

      // gitlab
      const r = await fetch('https://gitlab.com/api/v4/user', {
        headers: { 'PRIVATE-TOKEN': token, 'User-Agent': 'coro-runner' },
      })
      if (!r.ok) {
        const text = await r.text().catch(() => '')
        res.json({ ok: false, message: `GitLab ${r.status}: ${text.slice(0, 200) || r.statusText}` })
        return
      }
      const data = (await r.json()) as { username?: string; name?: string }
      res.json({ ok: true, message: `Authenticated as ${data.name ?? data.username ?? '(unknown)'}` })
    } catch (err) {
      logger.warn({ err }, 'POST /test/git failed')
      res.json({ ok: false, message: (err as Error).message })
    }
  })

  app.post('/test/tracker', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        provider?: string
        jira?: { baseUrl?: string; username?: string; apiToken?: string }
        linear?: { apiKey?: string; teamKey?: string }
        git?: { provider?: string; username?: string; token?: string; workspace?: string }
      }
      const provider = body.provider
      const existing = loadLocalConfig()

      if (provider === 'jira') {
        const baseUrl = (body.jira?.baseUrl ?? existing?.tracker?.jira?.baseUrl ?? '').trim()
        const username = (body.jira?.username ?? existing?.tracker?.jira?.username ?? '').trim()
        const apiToken = resolveSecret(body.jira?.apiToken, existing?.tracker?.jira?.apiToken)
        if (!baseUrl || !username || !apiToken) {
          res.json({ ok: false, message: 'Jira requires base URL, username, and API token.' })
          return
        }
        const auth = Buffer.from(`${username}:${apiToken}`).toString('base64')
        const r = await fetch(`${trimSlash(baseUrl)}/rest/api/3/myself`, {
          headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
        })
        if (!r.ok) {
          const text = await r.text().catch(() => '')
          res.json({ ok: false, message: `Jira ${r.status}: ${text.slice(0, 200) || r.statusText}` })
          return
        }
        const data = (await r.json()) as { displayName?: string; emailAddress?: string }
        res.json({
          ok: true,
          message: `Authenticated as ${data.displayName ?? data.emailAddress ?? username}`,
        })
        return
      }

      if (provider === 'linear') {
        const apiKey = resolveSecret(body.linear?.apiKey, existing?.tracker?.linear?.apiKey)
        if (!apiKey) {
          res.json({ ok: false, message: 'Linear requires an API key.' })
          return
        }
        const r = await fetch('https://api.linear.app/graphql', {
          method: 'POST',
          headers: {
            Authorization: apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: '{ viewer { id name email } }' }),
        })
        if (!r.ok) {
          const text = await r.text().catch(() => '')
          res.json({ ok: false, message: `Linear ${r.status}: ${text.slice(0, 200) || r.statusText}` })
          return
        }
        const data = (await r.json()) as {
          data?: { viewer?: { name?: string; email?: string } }
          errors?: Array<{ message?: string }>
        }
        if (data.errors?.length) {
          res.json({ ok: false, message: data.errors[0]?.message ?? 'Linear returned an error.' })
          return
        }
        const viewer = data.data?.viewer
        res.json({ ok: true, message: `Authenticated as ${viewer?.name ?? viewer?.email ?? '(unknown)'}` })
        return
      }

      if (provider === 'github') {
        // GitHub Issues reuses the git credential. Delegate to the same
        // ping the /test/git endpoint runs.
        const gitProvider = body.git?.provider ?? existing?.git?.provider
        if (gitProvider !== 'github') {
          res.json({
            ok: false,
            message: 'GitHub Issues requires the git provider to be GitHub.',
          })
          return
        }
        const username = (body.git?.username ?? existing?.git?.username ?? '').trim()
        const token = resolveSecret(body.git?.token, existing?.git?.token)
        if (!token) {
          res.json({ ok: false, message: 'GitHub token is required (set it in Source control).' })
          return
        }
        const r = await fetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'coro-runner',
          },
        })
        if (!r.ok) {
          const text = await r.text().catch(() => '')
          res.json({ ok: false, message: `GitHub ${r.status}: ${text.slice(0, 200) || r.statusText}` })
          return
        }
        const data = (await r.json()) as { login?: string }
        res.json({
          ok: true,
          message: `Authenticated as ${data.login ?? username ?? '(unknown)'}`,
        })
        return
      }

      if (provider === 'none') {
        res.json({ ok: true, message: 'No tracker configured.' })
        return
      }

      res.status(400).json({ ok: false, message: `Unsupported tracker provider "${provider}"` })
    } catch (err) {
      logger.warn({ err }, 'POST /test/tracker failed')
      res.json({ ok: false, message: (err as Error).message })
    }
  })

  app.get('/config/anthropic/claude-login/status', (_req: Request, res: Response) => {
    try {
      const state = claudeLoginManager.getState()
      if (state.status === 'connected') {
        saveClaudeLoginConfig(state.account)
      }
      res.json(state)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.post('/config/anthropic/claude-login/start', async (_req: Request, res: Response) => {
    try {
      const state = await claudeLoginManager.start()
      if (state.status === 'connected') {
        saveClaudeLoginConfig(state.account)
      }
      res.json(state)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.post('/config/anthropic/claude-login/callback', async (req: Request, res: Response) => {
    try {
      const authorizationCode = typeof req.body?.authorizationCode === 'string'
        ? req.body.authorizationCode.trim()
        : ''
      const callbackState = typeof req.body?.state === 'string'
        ? req.body.state
        : undefined

      if (!authorizationCode) {
        res.status(400).json({ error: 'authorizationCode is required' })
        return
      }

      const state = await claudeLoginManager.submitCallback({
        authorizationCode,
        state: callbackState,
      })
      if (state.status === 'connected') {
        saveClaudeLoginConfig(state.account)
      }
      res.json(state)
    } catch (err) {
      const message = (err as Error).message
      const status = message === 'No active Claude login flow' ? 409 : 500
      res.status(status).json({ error: message })
    }
  })

  // ── Generate Claude Code OAuth token ────────────────────────────────────
  //
  // Runs `claude setup-token` on the runner host. That command opens a
  // browser on the runner machine (which in local mode is the developer's
  // own laptop) and prints a long-lived token to stdout on success. We
  // prefer the Claude Code CLI that ships bundled with
  // `@anthropic-ai/claude-agent-sdk` (always present) so this works even
  // when the standalone `claude` binary isn't on PATH — which is common
  // when the runner is launched from a GUI/service launcher rather than
  // a login shell. If the bundled CLI can't be resolved for some reason
  // we fall back to spawning `claude` from PATH.
  //
  // Serialised via a simple in-flight flag so two dashboard tabs can't race.

  let setupTokenRunning = false

  app.post('/config/anthropic/generate-oauth-token', (_req: Request, res: Response) => {
    if (setupTokenRunning) {
      res.status(409).json({ error: 'IN_PROGRESS', message: 'Another token setup is already running' })
      return
    }
    setupTokenRunning = true

    // Resolve which CLI to spawn. Prefer the bundled one so we don't depend
    // on the user having a global `claude` on PATH.
    let cliCmd: string
    let cliArgs: string[]
    let usingBundled = false
    try {
      const cliPath = resolveClaudeCodeCliPath()
      ensureClaudeCodeCliExecutable(cliPath, logger)
      cliCmd = process.execPath // same node that's running the runner
      cliArgs = [cliPath, 'setup-token']
      usingBundled = true
    } catch (err) {
      logger.warn({ err }, 'Could not resolve bundled Claude Code CLI; falling back to `claude` on PATH')
      cliCmd = 'claude'
      cliArgs = ['setup-token']
    }

    // Prefer requesting the MCP server scope explicitly when supported so the
    // generated token can register in-process MCP servers used by the runner.
    // We keep a compatibility fallback for older CLIs that only support the
    // legacy no-flag flow.
    const requiredScopes = ['user:inference', 'user:mcp_servers'] as const
    const scopeFlag = detectSetupTokenScopeFlag(cliCmd, cliArgs, logger)
    const forceFlag = detectSetupTokenForceFlag(cliCmd, cliArgs, logger)
    const setupTokenArgsBase = scopeFlag === '--scope'
      ? [...cliArgs, '--scope', requiredScopes[0], '--scope', requiredScopes[1]]
      : scopeFlag === '--scopes'
        ? [...cliArgs, '--scopes', requiredScopes.join(',')]
        : [...cliArgs]
    const setupTokenArgs = forceFlag
      ? [...setupTokenArgsBase, forceFlag]
      : setupTokenArgsBase

    // The CLI uses Ink (React-for-terminals) to render the token inside a
    // `<Text>` component. Ink reads `process.stdout.columns` *directly* from
    // the TTY — setting the COLUMNS env var does NOT work. Without a TTY,
    // Ink defaults to 80 columns and hard-wraps the ~108-char OAuth token,
    // giving us a prefix-valid-but-truncated capture that the API then
    // rejects with 401. To fix this we wrap the CLI in `script`, which is
    // installed on every macOS and Linux host and gives the child process
    // a real pseudo-terminal. Inside the PTY we run `stty cols 10000` so
    // Ink doesn't wrap. `script` syntax differs between BSD (macOS) and
    // util-linux (Linux).
    //
    // Native Windows has no `script`/`/dev/tty` and a fundamentally
    // different TTY model (ConPTY). Spawning the CLI directly would
    // reproduce the 80-column truncation bug, so we refuse and tell the
    // user to paste a token manually (WSL users are `process.platform ===
    // 'linux'` and take the script path above).
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      setupTokenRunning = false
      res.status(501).json({
        error: 'PLATFORM_UNSUPPORTED',
        message: 'Automatic token generation is only supported on macOS and Linux. Run `claude setup-token` yourself in a terminal and paste the token into the OAuth token field below.',
      })
      return
    }

    const inner = `stty cols 10000 rows 10000 2>/dev/null; exec ${[cliCmd, ...setupTokenArgs].map(shellQuote).join(' ')}`
    const cmd = 'script'
    const args = process.platform === 'darwin'
      ? ['-q', '/dev/null', 'sh', '-c', inner]   // BSD: script [options] file [command...]
      : ['-q', '-c', inner, '/dev/null']          // util-linux: script [options] -c CMD file

    const spawnEnv = {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      TERM: 'xterm-256color', // script creates a real PTY, so use a sane TERM
      COLUMNS: '10000',
      LINES: '10000',
    }

    // BSD `script` (macOS) calls tcgetattr(STDIN) to copy terminal attrs
    // into the child PTY — it fails with `Operation not supported on
    // socket` if the runner's stdin is not a TTY. Open the controlling
    // terminal directly and pass it as the child's stdin so `script` is
    // happy even when the runner's own stdio is piped. If the runner has
    // no controlling terminal (daemon/service), `/dev/tty` won't open
    // and we fall back to `ignore`, which gives the user a clear error.
    let ttyStdin: number | 'ignore' = 'ignore'
    if (cmd === 'script') {
      try {
        ttyStdin = fs.openSync('/dev/tty', 'r')
      } catch {
        ttyStdin = 'ignore'
      }
    }

    let child
    try {
      child = spawn(cmd, args, {
        stdio: [ttyStdin, 'pipe', 'pipe'],
        env: spawnEnv,
      })
    } catch (err) {
      setupTokenRunning = false
      if (typeof ttyStdin === 'number') {
        try { fs.closeSync(ttyStdin) } catch { /* ignore */ }
      }
      res.status(500).json({ error: 'SPAWN_FAILED', message: (err as Error).message })
      return
    }

    // Close our duplicated /dev/tty fd now that the child owns it.
    if (typeof ttyStdin === 'number') {
      try { fs.closeSync(ttyStdin) } catch { /* ignore */ }
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    // Bound the wait so a hung browser flow doesn't leak the subprocess forever.
    const TIMEOUT_MS = 120_000
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      setupTokenRunning = false
      res.status(504).json({
        error: 'TIMEOUT',
        message: 'claude setup-token did not complete within 120s',
        authUrl: extractOauthUrl(stderr) ?? extractOauthUrl(stdout),
        stderr: stderr.trim().slice(0, 2000),
      })
    }, TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8') })

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      setupTokenRunning = false
      if (err.code === 'ENOENT') {
        const usingScript = cmd === 'script'
        res.status(404).json({
          error: 'CLI_NOT_FOUND',
          message: usingScript
            ? 'The `script` utility is not installed on the runner host (unusual on macOS/Linux). Install it or paste a token manually.'
            : usingBundled
              ? 'Could not spawn the bundled Claude Code CLI. Reinstall `@anthropic-ai/claude-agent-sdk` in the runner.'
              : 'The `claude` CLI is not on PATH. Install Claude Code and try again.',
        })
        return
      }
      res.status(500).json({ error: 'SPAWN_FAILED', message: err.message })
    })

    child.on('close', (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      setupTokenRunning = false

      // Parse token from stdout + stderr combined: Ink may route to either.
      // When wrapped in `script` the PTY produces `\r\n` line endings; we
      // normalise so our extractor regexes are not confused.
      const combined = `${stdout}\n${stderr}`.replace(/\r\n?/g, '\n')
      const token = extractOauthToken(combined)
      const authUrl = extractOauthUrl(combined)

      // Log a short preview (no secrets) so operators can diagnose a future
      // regression in the CLI's output format without re-running the flow.
      logger.info(
        {
          exitCode: code,
          usingBundled,
          scopeFlag: scopeFlag ?? 'none',
          forceFlag: forceFlag ?? 'none',
          requestedScopes: scopeFlag ? requiredScopes.join(',') : null,
          tokenFound: !!token,
          tokenLength: token?.length ?? 0,
          tokenPrefix: token ? `${token.slice(0, 16)}…` : null,
          tokenSuffix: token ? `…${token.slice(-6)}` : null,
          stdoutBytes: stdout.length,
          stderrBytes: stderr.length,
        },
        'claude setup-token finished',
      )

      if (code !== 0 && !token) {
        // `script` fails early if it can't set up a PTY (happens when the
        // runner has no controlling TTY, e.g. daemonised). Give the user a
        // directly-actionable message in that case.
        const scriptPtyFail = cmd === 'script' && /Operation not supported|tcgetattr|no controlling/i.test(stderr)
        res.status(500).json({
          error: scriptPtyFail ? 'NO_CONTROLLING_TTY' : 'SETUP_FAILED',
          exitCode: code,
          message: scriptPtyFail
            ? 'The runner has no controlling terminal, so the Claude Code CLI cannot allocate a PTY for the token flow. Start the runner from a terminal (e.g. `coro runner start` in Terminal.app) and retry, or paste a token generated elsewhere.'
            : undefined,
          stderr: stderr.trim().slice(0, 2000),
          authUrl,
        })
        return
      }

      if (!token) {
        res.status(500).json({
          error: 'NO_TOKEN_IN_OUTPUT',
          stdout: stdout.trim().slice(0, 2000),
          stderr: stderr.trim().slice(0, 2000),
          authUrl,
        })
        return
      }

      res.json({
        token,
        requestedScopes: scopeFlag ? requiredScopes : null,
        scopeRequestSupported: !!scopeFlag,
        forcedReauth: !!forceFlag,
        tokenKind: 'long-lived-inference-only',
        mcpCompatible: false,
        limitation:
          'Claude CLI setup-token produces a long-lived inference-only token in this runner version. It does not provide MCP scopes such as user:mcp_servers.',
        recommendation:
          'Use ANTHROPIC_API_KEY for MCP-enabled workflows in this app. This runner only stores a single OAuth token value and does not persist Claude refresh-token session state.',
      })
    })
  })

  // ── Dashboard (served under /dashboard/) ───────────────────────────────
  //
  // The dashboard now lives in a sibling workspace package (`@coro/dashboard`),
  // so we resolve its built `dist/` relative to the runner's package root and
  // tolerate two layouts:
  //   • compiled:  packages/runner/dist/src/runner/server.js  (4 levels up)
  //   • source:    packages/runner/src/runner/server.ts       (3 levels up)
  // We also accept an env override for non-monorepo deployments.

  const dashboardDir = resolveDashboardDist(logger)
  if (dashboardDir) {
    app.use('/dashboard', express.static(dashboardDir))
    app.get('/dashboard/*', (_req: Request, res: Response) => {
      res.sendFile(path.join(dashboardDir, 'index.html'), err => {
        if (err) res.status(404).json({ error: 'Not found' })
      })
    })
  } else {
    app.get('/dashboard/*', (_req: Request, res: Response) => {
      res.status(503).json({
        error: 'Dashboard build not found',
        hint: 'Run `pnpm --filter @coro/dashboard build` or set CORO_DASHBOARD_DIST.',
      })
    })
  }

  // Redirect root to dashboard for convenience
  app.get('/', (_req: Request, res: Response) => {
    res.redirect('/dashboard/')
  })

  // ── Start server ────────────────────────────────────────────────────────

  const server = http.createServer(app)
  server.listen(port, () => {
    logger.info({ port }, 'Runner HTTP server listening')
  })

  return server
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Sanitise a plugin's MCP server descriptor for transport over the HTTP
 * API. Tokens land in `env` (stdio) or `headers` (http/sse); we keep
 * the keys (so the operator can see *which* secrets are wired in) but
 * blank the values. The shape is otherwise pass-through so the
 * dashboard can render `command`, `args`, `url`, transport type, etc.
 */
function redactPluginMcpServer(desc: unknown): Record<string, unknown> | null {
  if (!desc || typeof desc !== 'object') return null
  const src = desc as Record<string, unknown>
  const out: Record<string, unknown> = { ...src }
  if (src.env && typeof src.env === 'object') {
    const redactedEnv: Record<string, string> = {}
    for (const k of Object.keys(src.env as Record<string, unknown>)) {
      redactedEnv[k] = '***'
    }
    out.env = redactedEnv
  }
  if (src.headers && typeof src.headers === 'object') {
    const redactedHeaders: Record<string, string> = {}
    for (const k of Object.keys(src.headers as Record<string, unknown>)) {
      redactedHeaders[k] = '***'
    }
    out.headers = redactedHeaders
  }
  return out
}

// ── Drop-in plugin install / uninstall helpers (S7) ──────────────────────────
//
// These wrap the same on-disk operations the `coro plugin install` /
// `coro plugin uninstall` CLI commands perform, but expose them as
// HTTP endpoints so the dashboard can drive the workflow without
// shelling out client-side. Both helpers are intentionally *not*
// transactional with the in-memory `PluginRegistry`: the runner reloads
// the registry on its next bootstrap. The endpoint responses surface a
// `restartHint` so the operator knows to bounce the runner.

interface InstallDropinResult {
  pluginDir: string
  manifest: { id: string; kind: string; version: string; displayName: string }
}

async function installDropinPlugin(args: {
  spec: string
  id?: string
  logger: Logger
}): Promise<InstallDropinResult> {
  const os = await import('node:os')
  const { spawn: spawnCp } = await import('node:child_process')

  const id = args.id ?? deriveIdFromSpec(args.spec)
  if (!id) {
    throw new Error(
      `Could not derive a plugin id from spec "${args.spec}". ` +
      `Pass an explicit \`id\` field in the request body.`,
    )
  }
  const dropinRoot = path.join(os.homedir(), '.coro', 'plugins')
  const pluginDir = path.join(dropinRoot, id)
  fs.mkdirSync(pluginDir, { recursive: true })
  if (!fs.existsSync(path.join(pluginDir, 'package.json'))) {
    fs.writeFileSync(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({ name: `coro-plugin-host-${id}`, private: true }, null, 2) + '\n',
    )
  }

  args.logger.info({ spec: args.spec, pluginDir }, 'Installing drop-in plugin')
  const code = await new Promise<number>((resolve) => {
    const child = spawnCp('npm', ['install', args.spec], { cwd: pluginDir, stdio: 'pipe' })
    child.stdout?.on('data', (chunk: Buffer) => args.logger.debug({ npm: 'stdout' }, chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => args.logger.debug({ npm: 'stderr' }, chunk.toString()))
    child.on('close', (c) => resolve(c ?? 1))
  })
  if (code !== 0) throw new Error(`npm install exited with code ${code}`)

  // Locate the package's coro-plugin.json — either at the install
  // dir's root or copied from `node_modules/<package>/`.
  const directManifest = path.join(pluginDir, 'coro-plugin.json')
  if (!fs.existsSync(directManifest)) {
    const nm = path.join(pluginDir, 'node_modules')
    const found = findPluginManifest(nm)
    if (!found) {
      throw new Error(
        `Installed package does not ship a coro-plugin.json. ` +
        `Either ${args.spec} is not a Coro plugin or it needs to declare ` +
        `the manifest under its package root.`,
      )
    }
    const inner = JSON.parse(fs.readFileSync(found.manifestPath, 'utf-8')) as { entry?: string }
    const synthetic = {
      ...inner,
      entry: path.relative(pluginDir, path.join(found.packageDir, inner.entry ?? 'index.js')),
    }
    fs.writeFileSync(directManifest, JSON.stringify(synthetic, null, 2) + '\n')
  }

  const manifestRaw = JSON.parse(fs.readFileSync(directManifest, 'utf-8')) as Record<string, unknown>
  return {
    pluginDir,
    manifest: {
      id: String(manifestRaw['id'] ?? id),
      kind: String(manifestRaw['kind'] ?? 'unknown'),
      version: String(manifestRaw['version'] ?? '0.0.0'),
      displayName: String(manifestRaw['displayName'] ?? id),
    },
  }
}

function listDropinPluginIds(): Set<string> {
  const ids = new Set<string>()
  try {
    const os = require('node:os') as typeof import('node:os')
    const root = path.join(os.homedir(), '.coro', 'plugins')
    if (!fs.existsSync(root)) return ids
    for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue
      const manifest = path.join(root, dirent.name, 'coro-plugin.json')
      if (fs.existsSync(manifest)) ids.add(dirent.name)
    }
  } catch {
    // Permission errors etc. — fall through with whatever we got.
  }
  return ids
}

async function uninstallDropinPlugin(args: { id: string; logger: Logger }): Promise<string | null> {
  const os = await import('node:os')
  const dir = path.join(os.homedir(), '.coro', 'plugins', args.id)
  if (!fs.existsSync(dir)) return null
  fs.rmSync(dir, { recursive: true, force: true })
  args.logger.info({ pluginDir: dir }, 'Removed drop-in plugin')
  return dir
}

function deriveIdFromSpec(spec: string): string | undefined {
  const scoped = spec.match(/^@[^/]+\/(?:plugin-)?(.+)$/)
  if (scoped?.[1]) return scoped[1].replace(/[^a-z0-9-]/gi, '').toLowerCase()
  const bare = spec.match(/(?:^|\/)(?:coro-plugin-)?([^/]+?)(?:\.git)?$/)
  if (bare?.[1]) return bare[1].replace(/[^a-z0-9-]/gi, '').toLowerCase()
  return undefined
}

interface FoundPluginManifest { manifestPath: string; packageDir: string }

function findPluginManifest(rootDir: string): FoundPluginManifest | undefined {
  if (!fs.existsSync(rootDir)) return undefined
  for (const dirent of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    const dir = path.join(rootDir, dirent.name)
    const manifest = path.join(dir, 'coro-plugin.json')
    if (fs.existsSync(manifest)) return { manifestPath: manifest, packageDir: dir }
    if (dirent.name.startsWith('@')) {
      for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue
        const subManifest = path.join(dir, sub.name, 'coro-plugin.json')
        if (fs.existsSync(subManifest)) {
          return { manifestPath: subManifest, packageDir: path.join(dir, sub.name) }
        }
      }
    }
  }
  return undefined
}
