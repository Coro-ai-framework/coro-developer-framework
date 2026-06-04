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
import { spawn } from 'child_process'
import { Logger } from 'pino'
import type { Dispatcher } from '../jobs/dispatcher'
import type { StateBackend } from '../state/backend'
import type { PluginRegistry } from '../plugins/registry'
import type { RunnerContext } from '../jobs/runner'
import type { PluginRuntime } from '../plugins/types'
import { reloadRunnerState, type ReloadResult } from './config-reload'
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
import { createJobInput, type CreateJobRequest } from '../jobs/creation'
import { resolveJobWorkspaceLayout } from '../jobs/workspace-layout'
import { computeJobDiff, emptyJobDiff, resolveDiffBase } from '../jobs/job-diff'
import { assertJobPluginRequirements } from '../jobs/plugin-preflight'
import { incrementCoachModeRunCount } from '../config/coach-mode'
import { runIntakeStream } from '../intake/handler'
import { type Job, type CampaignChild, type Insight, type InsightLayer, type InsightStatus } from '@coro-ai/cloud-protocol'
import { isStoppedStatus } from '../jobs/helpers'
import { resolveDashboardDist } from '../dashboard-dist'
import { formatSseFrame } from './sse'
import { listBuiltinPluginMetadata, BUILTIN_PLUGIN_IDS_BY_KIND } from '../plugins/builtin'
import { discoverWorkflows } from '../workflow-discovery'
import { loadWorkflowConfigFromRoots } from '../workflow-parser'
import { buildIntelligenceCatalogue } from '../intelligence-catalogue'
import { inferKind, validateArtefact } from '../intelligence-validator'
import { getBaseLayerRoot } from '@coro-ai/intelligence-base'
import { resolveGuardrails } from '../guardrails'

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
  /**
   * Live `RunnerContext` reference. Required for the hot-reload path
   * triggered after `PUT /config` / `POST /plugins/install`: the
   * server mutates `ctx.settings` / `ctx.gitClient` / `ctx.plugins`
   * field-by-field on the same reference so the Dispatcher (which
   * holds `ctx` privately) picks up the new values for the next job
   * without a runner restart. Optional purely for back-compat with
   * tests that exercise the server in isolation.
   */
  runnerCtx?: RunnerContext
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
 * Heuristic: does a plugin-config field name look like a secret?
 *
 * Plugin manifests (`PluginManifest.configSchema`) use arbitrary
 * field names — we don't have a "this is a secret" annotation in the
 * schema today. Rather than force every plugin to declare a secret
 * list, we redact based on common naming conventions. Callers should
 * still treat the heuristic as best-effort and prefer to rotate
 * tokens that ever leaked through the dashboard.
 */
function isSecretFieldName(name: string): boolean {
  return /token|apikey|api_key|password|secret|appPassword/i.test(name)
}

/**
 * Walk a plugin-config object and replace every secret-shaped field
 * with the standard `...`-redaction. Used by GET /config so the
 * dashboard can hint that a value is set without ever shipping the
 * real credential to the browser. The PUT handler reverses the round
 * trip via {@link isRedacted}.
 */
function redactPluginConfig(cfg: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!cfg) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v === 'string' && isSecretFieldName(k)) {
      out[k] = redactSecret(v)
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * Per-key merge that preserves on-disk values when the incoming
 * value is the redacted `...` placeholder. Mirrors the round-trip
 * pattern used for git/tracker/anthropic/MCP secrets.
 */
function mergePluginConfig(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const prev = existing ?? {}
  if (!incoming) return { ...prev }
  const out: Record<string, unknown> = { ...prev }
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined) continue
    if (isSecretFieldName(k) && isRedacted(v)) {
      // keep prior secret
      if (!(k in out)) continue
      continue
    }
    out[k] = v
  }
  return out
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

  // Plugins block: drop installed entries with no config and `enabled !== false`
  // is harmless to persist. We always drop entries that have neither config
  // keys nor an explicit enabled flag so the file stays tidy.
  const plugins = out.plugins as
    | { defaults?: { scm?: unknown; tracker?: unknown }; installed?: Record<string, { enabled?: unknown; config?: unknown }> }
    | undefined
  if (plugins) {
    const cleaned: { defaults?: Record<string, string>; installed: Record<string, { enabled?: boolean; config: Record<string, unknown> }> } = {
      installed: {},
    }
    if (plugins.defaults) {
      const d: Record<string, string> = {}
      if (typeof plugins.defaults.scm === 'string' && plugins.defaults.scm.length > 0) d['scm'] = plugins.defaults.scm
      if (typeof plugins.defaults.tracker === 'string' && plugins.defaults.tracker.length > 0) d['tracker'] = plugins.defaults.tracker
      if (Object.keys(d).length > 0) cleaned.defaults = d
    }
    for (const [id, raw] of Object.entries(plugins.installed ?? {})) {
      if (!raw || typeof raw !== 'object') continue
      const cfg = (raw.config && typeof raw.config === 'object' ? raw.config : {}) as Record<string, unknown>
      const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : undefined
      const hasConfig = Object.keys(cfg).length > 0
      if (!hasConfig && enabled === undefined) continue
      cleaned.installed[id] = {
        ...(enabled !== undefined ? { enabled } : {}),
        config: cfg,
      }
    }
    if (Object.keys(cleaned.installed).length === 0 && !cleaned.defaults) {
      delete out.plugins
    } else {
      out.plugins = cleaned
    }
  }

  return out
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
      awaitingEvent?: string
      rateLimitInfo?: Job['rateLimitInfo']
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
          awaitingEvent: childJob.awaitingEvent,
          rateLimitInfo: childJob.rateLimitInfo,
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
        awaitingEvent?: string
        rateLimitInfo?: Job['rateLimitInfo']
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
 * Whitelist of artefact file extensions a developer may rewrite from the
 * dashboard. Restricted to text-like formats so we can't accidentally let
 * the artefact editor stomp on binary assets or scripts the agent shipped.
 */
const EDITABLE_ARTIFACT_EXTENSIONS = new Set(['.md', '.txt', '.yml', '.yaml', '.json'])

function isEditableArtifactPath(filePath: string): boolean {
  return EDITABLE_ARTIFACT_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

/**
 * Hard cap on developer-uploaded artefact bodies. Generous compared to
 * typical spec / plan markdown (~10–50 KB) but blocks abuse.
 */
const MAX_ARTIFACT_EDIT_BYTES = 2 * 1024 * 1024

/**
 * Create and start the runner's local HTTP server.
 * CLI commands (`coro job`, `coro status`, etc.) talk to this.
 */
export function createRunnerServer(opts: RunnerServerOptions): http.Server {
  const { port, dispatcher, stateBackend, logger, mode = 'hybrid', tenantId, plugins, runnerCtx } = opts
  const app = express()
  app.use(express.json())

  // ── Plugin HTTP-route helpers (boot + late-mount) ───────────────────────
  //
  // Both the boot-time route registration loop (further below in this
  // file) and the hot-reload late-mount path (used after a new plugin
  // slot is added via `PUT /config` / `POST /plugins/install`) share
  // these helpers. Keeping them as named locals here means a
  // late-mounted plugin sees identical `saveLocalConfig` /
  // `savePluginConfig` semantics — including the auto-elect-default-LLM
  // logic — as one that was registered at boot.
  const pluginSaveLocalConfig = (patch: Record<string, unknown>): void => {
    const existing = loadLocalConfig() ?? ({} as LocalConfig)
    saveLocalConfig({ ...existing, ...patch } as LocalConfig)
  }
  const pluginSavePluginConfig = (
    pluginId: string,
    configPatch: Record<string, unknown>,
  ): void => {
    const existing = loadLocalConfig() ?? ({} as LocalConfig)
    const existingPlugins = existing.plugins ?? { installed: {} }
    const existingInstalled = existingPlugins.installed ?? {}
    const existingEntry = existingInstalled[pluginId] ?? { enabled: true, config: {} }
    const existingConfig = (existingEntry.config ?? {}) as Record<string, unknown>
    const nextEntry = {
      ...existingEntry,
      enabled: existingEntry.enabled ?? true,
      config: { ...existingConfig, ...configPatch },
    }
    // Auto-elect this plugin as the default LLM provider when it is an
    // executor and the user has not yet picked one. Mirrors the
    // first-run wizard so claude-login produces a usable default in
    // one step.
    const runtime = (runnerCtx?.plugins ?? plugins)?.byId(pluginId)
    const isExecutor = runtime?.manifest.kind === 'executor'
    const existingLlm = (existing.llm ?? {}) as { defaultProvider?: string; aliases?: unknown }
    const nextLlm = isExecutor && !existingLlm.defaultProvider
      ? { ...existingLlm, defaultProvider: pluginId }
      : existingLlm
    saveLocalConfig({
      ...existing,
      llm: nextLlm,
      plugins: {
        ...existingPlugins,
        installed: { ...existingInstalled, [pluginId]: nextEntry },
      },
    } as LocalConfig)
  }

  // ── Hot reload of in-memory runner state ────────────────────────────────
  //
  // Built once here so both `PUT /config` and `POST /plugins/install`
  // can call the same function. The closure captures `app` so newly
  // instantiated plugins can mount their HTTP routes against the live
  // express stack at runtime. See `runner/config-reload.ts` for the
  // rebuild semantics.
  const lateMountPlugin = (runtime: PluginRuntime): void => {
    if (typeof runtime.registerHttpRoutes !== 'function') return
    try {
      runtime.registerHttpRoutes({
        app,
        logger,
        saveLocalConfig: pluginSaveLocalConfig,
        savePluginConfig: pluginSavePluginConfig,
        redactSecret,
      })
    } catch (err) {
      logger.error({ err, plugin: runtime.manifest.id }, 'Late-mount plugin HTTP routes failed')
    }
  }

  /**
   * Reload runner state from `~/.coro/config.json` and surface the
   * outcome to the dashboard. Wrapped in a single helper so both
   * config-write endpoints share the same try/log/return path.
   * Never throws — failures are downgraded to a warn-log + an empty
   * `ReloadResult`-shaped object so a misbehaving plugin can't 500
   * the unrelated save endpoint.
   */
  const reloadInMemoryState = async (): Promise<ReloadResult | null> => {
    if (!runnerCtx) return null
    try {
      return await reloadRunnerState({ ctx: runnerCtx, lateMountPlugin, logger })
    } catch (err) {
      logger.warn({ err }, 'Hot reload of runner state failed — restart may be required')
      return { updated: [], added: [], failed: [{ id: '*', error: (err as Error).message }] }
    }
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
  const ALLOWED_PREFIXES = ['workflows/', 'agents/', '.claude/skills/', 'memory/']

  type ValidatedTarget =
    | { ok: true; layer: 'base' | 'tenant' | 'repo'; pathParam: string; root: string }
    | { ok: false; status: number; error: string }

  function validateTarget(req: Request, opts: { writable?: boolean } = {}): ValidatedTarget {
    const layerParam = String(req.query.layer ?? (req.body && req.body.layer) ?? '')
    const pathParam = String(req.query.path ?? (req.body && req.body.path) ?? '')

    if (layerParam !== 'base' && layerParam !== 'tenant' && layerParam !== 'repo') {
      return { ok: false, status: 400, error: 'layer must be one of base|tenant|repo' }
    }
    if (opts.writable && layerParam === 'base') {
      return { ok: false, status: 403, error: 'base layer is read-only; choose tenant or repo' }
    }
    if (!pathParam) {
      return { ok: false, status: 400, error: 'path is required' }
    }
    if (pathParam.includes('..') || pathParam.startsWith('/')) {
      return { ok: false, status: 400, error: 'path must be relative and may not contain ..' }
    }
    if (!ALLOWED_PREFIXES.some(p => pathParam.startsWith(p))) {
      return {
        ok: false,
        status: 400,
        error: `path must start with one of: ${ALLOWED_PREFIXES.join(', ')}`,
      }
    }

    const config = loadLocalConfig()
    let root: string
    if (layerParam === 'base') root = getBaseLayerRoot()
    else if (layerParam === 'tenant') root = resolveIntelligenceDir(config)
    else {
      // Repo overlay isn't wired in solo mode yet (tracked separately).
      return { ok: false, status: 409, error: 'repo overlay is not currently mounted' }
    }
    return { ok: true, layer: layerParam, pathParam, root }
  }

  app.get('/intelligence/file', async (req: Request, res: Response): Promise<void> => {
    const v = validateTarget(req)
    if (!v.ok) {
      res.status(v.status).json({ error: v.error })
      return
    }
    const { layer: layerParam, pathParam } = v

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

  // Write (create or replace) an intelligence file in a writable layer.
  // Body: { layer, path, content }. Refuses base. Creates parent dirs.
  app.put('/intelligence/file', async (req: Request, res: Response): Promise<void> => {
    const v = validateTarget(req, { writable: true })
    if (!v.ok) {
      res.status(v.status).json({ error: v.error })
      return
    }
    const content = req.body?.content
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content must be a string' })
      return
    }
    // Validate per-kind so we never write a workflow that the runner
    // can't parse, etc. Callers can opt out via ?force=1 (the dashboard
    // doesn't do that today; the CLI may, with a warning).
    const force = req.query.force === '1' || req.query.force === 'true'
    const kind = inferKind(v.pathParam)
    if (kind && !force) {
      const result = validateArtefact(kind, v.pathParam, content)
      if (!result.ok) {
        res.status(422).json({
          error: 'validation failed',
          errors: result.errors,
          warnings: result.warnings,
        })
        return
      }
    }
    try {
      const target = path.join(v.root, v.pathParam)
      await fs.promises.mkdir(path.dirname(target), { recursive: true })
      await fs.promises.writeFile(target, content, 'utf-8')
      logger.info({ layer: v.layer, path: v.pathParam, bytes: content.length }, 'Intelligence file written')
      res.json({ layer: v.layer, path: v.pathParam, bytes: content.length })
    } catch (err) {
      logger.error({ err }, 'PUT /intelligence/file failed')
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Dry-run validation. Lets the dashboard show errors live before save.
  app.post('/intelligence/preflight', (req: Request, res: Response): void => {
    const pathParam = String(req.body?.path ?? '')
    const content = req.body?.content
    if (!pathParam) {
      res.status(400).json({ error: 'path is required' })
      return
    }
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content must be a string' })
      return
    }
    const kind = inferKind(pathParam)
    if (!kind) {
      res.status(400).json({
        error: 'path must start with one of: workflows/, agents/, .claude/skills/, memory/',
      })
      return
    }
    const result = validateArtefact(kind, pathParam, content)
    res.json({ kind, ...result })
  })

  // Delete an overlay file (revert to lower layer). Refuses base.
  app.delete('/intelligence/file', async (req: Request, res: Response): Promise<void> => {
    const v = validateTarget(req, { writable: true })
    if (!v.ok) {
      res.status(v.status).json({ error: v.error })
      return
    }
    try {
      const target = path.join(v.root, v.pathParam)
      try {
        await fs.promises.unlink(target)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(404).json({ error: `File not found in ${v.layer} layer` })
          return
        }
        throw err
      }
      // Best-effort: clean up empty parent directories under the layer root,
      // but never the layer root itself.
      let dir = path.dirname(target)
      while (dir.startsWith(v.root) && dir !== v.root) {
        try {
          await fs.promises.rmdir(dir)
        } catch {
          break
        }
        dir = path.dirname(dir)
      }
      logger.info({ layer: v.layer, path: v.pathParam }, 'Intelligence file deleted')
      res.json({ layer: v.layer, path: v.pathParam, deleted: true })
    } catch (err) {
      logger.error({ err }, 'DELETE /intelligence/file failed')
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // ── Workflows ───────────────────────────────────────────────────────────
  //
  // Enumerate every workflow.md the runner can dispatch against,
  // walking the layered intelligence stack (tenant overlay first,
  // then the base layer that ships with @coro-ai/intelligence-base).
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
      const builtinMetadata = await listBuiltinPluginMetadata(logger)
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
            ...(m.ui ? { ui: m.ui } : {}),
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
  // pipeline without shelling out client-side. The handler triggers a
  // hot reload immediately so the registry picks up the new drop-in
  // without a runner restart; the `restartHint` field is only set
  // when the slot isn't configured yet and the reload couldn't load it.
  app.post('/plugins/install', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { spec?: unknown; id?: unknown }
      if (typeof body.spec !== 'string' || body.spec.length === 0) {
        res.status(400).json({ error: '`spec` (npm package spec) is required' })
        return
      }
      const explicitId = typeof body.id === 'string' && body.id.length > 0 ? body.id : undefined
      const result = await installDropinPlugin({ spec: body.spec, id: explicitId, logger })

      // Try a hot reload so the registry picks up the new drop-in
      // immediately. The plugin only loads if a `plugins.installed.<id>`
      // slot exists in config — for first-time installs the dashboard
      // typically follows up with a `PUT /config` to add the slot, and
      // that PUT triggers its own reload. We still attempt one here so
      // a slot that was pre-configured (or carries no required config)
      // is live without a manual save.
      const reload = await reloadInMemoryState()
      const loaded =
        reload?.added.includes(result.manifest.id) ||
        reload?.updated.includes(result.manifest.id) ||
        false

      res.json({
        ok: true,
        installedAt: result.pluginDir,
        manifest: result.manifest,
        ...(reload ? { reload } : {}),
        ...(loaded
          ? {}
          : {
              restartHint:
                'Plugin installed on disk. Configure it in Settings to enable it; the registry picks up the new plugin as soon as you save credentials.',
            }),
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

  // GET /plugins/:id/models — proxies the executor plugin's static
  // model catalogue to the dashboard so the aliases editor can offer a
  // dropdown without hard-coding model ids per provider. Returns 404
  // for unknown plugin ids and 400 for non-executor plugins.
  app.get('/plugins/:id/models', (req: Request, res: Response) => {
    try {
      const rawId = req.params['id']
      const id = typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] : undefined
      if (!id) {
        res.status(400).json({ error: 'Plugin id is required' })
        return
      }
      const runtime = plugins?.all().find(r => r.manifest.id === id)
      if (!runtime) {
        res.status(404).json({ error: `Plugin "${id}" is not registered` })
        return
      }
      if (runtime.manifest.kind !== 'executor') {
        res.status(400).json({ error: `Plugin "${id}" is not an executor plugin` })
        return
      }
      const exec = runtime as unknown as { listModels?: () => ReadonlyArray<{ id: string; displayName?: string; capabilities?: Record<string, boolean> }> }
      if (typeof exec.listModels !== 'function') {
        res.json({ models: [] })
        return
      }
      res.json({ models: exec.listModels() })
    } catch (err) {
      logger.error({ err }, 'GET /plugins/:id/models failed')
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /plugins/:id/healthcheck — proxies the plugin's
  // `healthcheck()` so the dashboard can verify a provider is
  // configured without dispatching a real job. Generic across plugin
  // kinds; the dashboard's "Test connection" buttons + the Home
  // readiness banner both use this.
  //
  // Optional body: `{ config?: Record<string, unknown> }`. When
  // supplied, the runner spins up an ephemeral re-init with the
  // merged (on-disk + draft) config so the FTUE wizard can verify a
  // credential before the user saves. Redacted `...` values fall back
  // to whatever is on disk so partial drafts still test cleanly.
  app.post('/plugins/:id/healthcheck', async (req: Request, res: Response) => {
    try {
      const rawId = req.params['id']
      const id = typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] : undefined
      if (!id) {
        res.status(400).json({ error: 'Plugin id is required' })
        return
      }
      const runtime = plugins?.all().find(r => r.manifest.id === id)
      if (!runtime) {
        res.status(404).json({ error: `Plugin "${id}" is not registered` })
        return
      }

      const body = (req.body ?? {}) as { config?: Record<string, unknown> }
      if (body.config && typeof body.config === 'object') {
        // Caller wants to test a draft config. Reinitialise the plugin
        // with the merged config (drops back to on-disk for redacted
        // secrets), run healthcheck, then restore the persisted state
        // so we don't leave the registry in a weird mid-draft mode.
        const existing = loadLocalConfig()
        const onDisk = (existing?.plugins?.installed?.[id]?.config ?? {}) as Record<string, unknown>
        const merged: Record<string, unknown> = { ...onDisk }
        for (const [k, v] of Object.entries(body.config)) {
          if (typeof v === 'string' && isRedacted(v)) continue
          merged[k] = v
        }
        const pluginDeps = { logger, fetch: fetch.bind(globalThis) }
        try {
          await runtime.init(merged, pluginDeps)
          const health = await runtime.healthcheck()
          res.json(health)
        } finally {
          // Best-effort restore. If the on-disk config is malformed
          // the plugin keeps the draft state until the next runner
          // restart — the dashboard surfaces this via the standard
          // save flow.
          try {
            await runtime.init(onDisk, pluginDeps)
          } catch (restoreErr) {
            logger.warn(
              { err: restoreErr, plugin: id },
              'Failed to restore plugin config after draft healthcheck',
            )
          }
        }
        return
      }

      const health = await runtime.healthcheck()
      res.json(health)
    } catch (err) {
      logger.error({ err }, 'POST /plugins/:id/healthcheck failed')
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
      try {
        incrementCoachModeRunCount()
      } catch (coachErr) {
        logger.warn({ err: coachErr }, 'Failed to increment coach mode run count — non-fatal')
      }
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

  app.post('/intake/stream', async (req: Request, res: Response) => {
    if (!plugins || !runnerCtx) {
      res.status(503).json({ error: 'Coro plan mode unavailable — runner plugins not initialized', reason: 'no-llm' })
      return
    }

    const body = req.body as {
      sessionId?: string
      messages?: Array<{ role: 'user' | 'assistant'; content: string }>
      model?: string
      provider?: string
      context?: {
        recentRepos?: string[]
        recentReviewers?: string[]
        availableWorkflows?: Array<{ id: string; name: string; workflowPath: string; description: string }>
        userLocale?: string
      }
    }

    if (typeof body?.sessionId !== 'string' || !body.sessionId.trim()) {
      res.status(400).json({ error: 'sessionId is required' })
      return
    }
    if (!Array.isArray(body.messages)) {
      res.status(400).json({ error: 'messages array is required' })
      return
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    // Plan-mode requests are short (a single LLM round-trip, typically
    // under 10s). We intentionally do NOT tie the LLM's abort signal
    // to `req.close` / `res.close`: under Express 4 + Node 20 the
    // request emits 'close' as soon as `express.json()` finishes
    // draining the POST body, which would cancel every LLM call a few
    // ms after it starts. If the browser disconnects mid-flight we'll
    // simply write SSE bytes into a closed socket — harmless. Longer-
    // running stream surfaces should bring their own cancellation
    // protocol rather than borrow the HTTP request lifecycle.
    const abortController = new AbortController()
    logger.debug({ url: req.originalUrl }, 'intake stream: request received')

    try {
      for await (const event of runIntakeStream({
        sessionId: body.sessionId.trim(),
        messages: body.messages,
        ...(typeof body.model === 'string' && body.model.trim()
          ? { model: body.model.trim(), provider: typeof body.provider === 'string' ? body.provider.trim() : undefined }
          : {}),
        context: {
          recentRepos: body.context?.recentRepos ?? [],
          recentReviewers: body.context?.recentReviewers ?? [],
          availableWorkflows: body.context?.availableWorkflows ?? [],
          userLocale: body.context?.userLocale,
        },
        registry: plugins,
        settings: runnerCtx.settings,
        signal: abortController.signal,
        logger,
      })) {
        if (event.type === 'token') {
          res.write(formatSseFrame(JSON.stringify({ type: 'token', text: event.text }), 'message'))
        } else if (event.type === 'tool_start') {
          res.write(formatSseFrame(JSON.stringify({
            type: 'tool_start',
            name: event.name,
            input: event.input,
          }), 'message'))
        } else if (event.type === 'tool_end') {
          res.write(formatSseFrame(JSON.stringify({
            type: 'tool_end',
            name: event.name,
            durationMs: event.durationMs,
            ok: event.ok,
            summary: event.summary,
            ...(event.error ? { error: event.error } : {}),
          }), 'message'))
        } else if (event.type === 'done') {
          res.write(formatSseFrame(JSON.stringify({ type: 'done', usage: event.usage }), 'message'))
        } else if (event.type === 'error') {
          const payload: Record<string, unknown> = { type: 'error', message: event.message }
          if ((event as { reason?: string }).reason) payload['reason'] = (event as { reason?: string }).reason
          res.write(formatSseFrame(JSON.stringify(payload), 'message'))
        }
      }
      res.write(formatSseFrame(JSON.stringify({ type: 'done' }), 'done'))
    } catch (err) {
      logger.error({ err }, 'POST /intake/stream failed')
      res.write(formatSseFrame(JSON.stringify({ type: 'error', message: (err as Error).message }), 'message'))
    } finally {
      res.end()
    }
  })

  // ── Job CRUD ────────────────────────────────────────────────────────────

  /**
   * Read-time backfill for `Job.workflowPhases`. The dashboard's full-
   * pipeline strip (with not-yet-started "ghost" phases) renders from
   * this snapshot; jobs created before the field existed have it
   * missing, and jobs whose workflow file gained / lost a phase
   * mid-life have it out of date. We resynthesise from the resolved
   * workflow config and persist on first read so the next refetch is
   * cheap. The dispatch-time backfill in `runJob` covers running jobs;
   * this covers parked / mid-LLM-call jobs that haven't ticked since
   * the field was introduced.
   */
  async function enrichWorkflowPhasesIfMissing(job: Job): Promise<Job> {
    if (!job.workflowPath) return job
    try {
      const resolved = await loadWorkflowConfigFromRoots(
        job.workflowPath,
        [getBaseLayerRoot()],
        logger,
      )
      if (!resolved) return job
      const expected = resolved.config.phases.map(p => ({
        name: p.name,
        status: p.status,
        agent: p.agent ?? null,
        ...(p.interactiveCheckpoint ? { interactiveCheckpoint: true } : {}),
      }))
      const current = job.workflowPhases ?? []
      const sameOrder
        = current.length === expected.length
        && current.every((p, i) => p.name === expected[i]?.name)
      // Also re-emit when any new per-phase field (e.g. `agent`) is
      // missing on the persisted entries — older jobs predate those
      // fields and would otherwise never be backfilled.
      const missingAgent = current.some(p => !('agent' in p))
      if (sameOrder && !missingAgent) return job
      await stateBackend.updateJob(job.id, { workflowPhases: expected })
      return { ...job, workflowPhases: expected }
    } catch (err) {
      logger.warn({ err, jobId: job.id }, 'Workflow-phase backfill skipped')
      return job
    }
  }

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
      let job = await stateBackend.getJob(jobId)
      if (!job) { res.status(404).json({ error: 'Job not found' }); return }
      // Opportunistic backfill of `workflowPhases` for legacy jobs (or
      // jobs whose snapshot fell out of sync with the workflow file).
      // Mirrors the dispatch-time backfill in `runJob`, but fires from
      // a plain HTTP read so the dashboard ghost-phase strip lights up
      // for jobs currently parked / mid-LLM-call without waiting for a
      // phase boundary.
      job = await enrichWorkflowPhasesIfMissing(job)
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

  // Abandon = unified Skip-or-Cancel (the dashboard's single button). Idempotent
  // on already-terminated children: a double-click returns 200 with a no-op
  // payload instead of a 4xx. Legacy `/skip` and `/cancel` routes remain for
  // MCP back-compat; the dashboard only calls /abandon.
  app.post('/jobs/:jobId/children/:name/abandon', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const name = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined
      await dispatcher.campaignAbandonChild(jobId, name, reason)
      res.json({ ok: true, action: 'abandon', child: name })
    } catch (err) {
      const msg = (err as Error).message
      const code = /not found/i.test(msg) ? 404 : 400
      res.status(code).json({ error: msg })
    }
  })

  // Resume = re-enter the existing failed/escalated child Job at its last
  // phase. Optional `note` becomes a framed developer-input message via
  // the dispatcher's sendMessage path.
  app.post('/jobs/:jobId/children/:name/resume', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const name = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name
      const note = typeof req.body?.note === 'string' ? req.body.note : undefined
      await dispatcher.campaignResumeChild(jobId, name, note)
      res.json({ ok: true, action: 'resume', child: name })
    } catch (err) {
      const msg = (err as Error).message
      const code = /not found/i.test(msg) ? 404 : 400
      res.status(code).json({ error: msg })
    }
  })

  // Start = manually dispatch a ready child, bypassing the parallelism
  // cap / halt-on-failure pause. Safe because `ready` already means
  // dependencies are satisfied. Rejects non-ready children with a 400.
  app.post('/jobs/:jobId/children/:name/start', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const name = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name
      await dispatcher.campaignStartChild(jobId, name)
      res.json({ ok: true, action: 'start', child: name })
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

  // ── Job code diff (PR preview) ──────────────────────────────────────────
  // Returns the changes the agent has made in the cloned target repo,
  // relative to the base branch. Powers the dashboard "Changes" tab and the
  // pre-PR preview gate so developers can see exactly what is being built
  // before any PR is opened on the SCM.
  //
  // Read-only: it never mutates the checkout. The repo dir is resolved from
  // the job's workspace layout and confined to `{workingDir}/{jobId}/`.
  app.get('/jobs/:jobId/diff', async (req: Request, res: Response) => {
    const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId

    try {
      const job = await stateBackend.getJob(jobId)
      if (!job) {
        res.status(404).json({ error: `Job not found: ${jobId}` })
        return
      }

      const config = loadLocalConfig()
      const workingDir = resolveLocalWorkingDir(config)
      const jobWorkingDir = path.resolve(workingDir, jobId)
      const layout = resolveJobWorkspaceLayout(job, jobWorkingDir)

      // No repo checkout registered yet (job hasn't reached coding). Report
      // an empty-but-available diff so the dashboard shows a clean state.
      if (!layout.repoCheckoutAbsDir) {
        res.json(emptyJobDiff(typeof req.query.base === 'string' ? req.query.base : undefined))
        return
      }

      const repoDir = path.resolve(layout.repoCheckoutAbsDir)
      if (!repoDir.startsWith(jobWorkingDir + path.sep) && repoDir !== jobWorkingDir) {
        logger.warn({ jobId, repoDir }, 'Job diff repo path escape attempt blocked')
        res.status(400).json({ error: 'Repo checkout is outside the job working directory' })
        return
      }

      // Allow conservative ref characters only; git refs never contain spaces,
      // `~^:?*[` or `..`. This keeps the value tame even though simple-git passes
      // args as an array (no shell), and rejects obvious garbage early.
      const safeRef = (v: unknown): string | undefined => {
        if (typeof v !== 'string') return undefined
        const t = v.trim()
        if (!t || t.length > 255 || t.includes('..') || /[\s~^:?*[\\]/.test(t)) return undefined
        return t
      }
      const baseParam = safeRef(req.query.base)
      const headParam = safeRef(req.query.head)
      const diff = await computeJobDiff({ repoDir, base: resolveDiffBase(job, baseParam), head: headParam })
      res.json(diff)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ err, jobId }, 'Job diff computation failed')
      res.status(500).json({ error: `Could not compute job diff: ${msg}` })
    }
  })

  // Developer-facing edit endpoint. The dashboard artefact reader uses this
  // to let humans tweak agent-produced specs / plans / reports before
  // approving the phase, without needing to drop into a terminal. Editing
  // is restricted to text-like extensions (see EDITABLE_ARTIFACT_EXTENSIONS)
  // and the same path-traversal guards as the GET sibling above.
  app.put('/jobs/:jobId/artifacts/:artifactId/content', async (req: Request, res: Response) => {
    const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
    const artifactId = Array.isArray(req.params.artifactId) ? req.params.artifactId[0] : req.params.artifactId

    try {
      const job = await stateBackend.getJob(jobId)
      if (!job) {
        res.status(404).json({ error: `Job not found: ${jobId}` })
        return
      }

      const artifacts = job.artifacts ?? []
      const artifactIdx = artifacts.findIndex(a => a.id === artifactId)
      if (artifactIdx === -1) {
        res.status(404).json({ error: `Artifact not found: ${artifactId}` })
        return
      }
      const artifact = artifacts[artifactIdx]

      const rawPath = (artifact.data as Record<string, unknown> | undefined)?.['path']
      if (typeof rawPath !== 'string' || !rawPath.trim()) {
        res.status(400).json({ error: 'Artifact has no `data.path` to edit' })
        return
      }
      if (!isEditableArtifactPath(rawPath)) {
        res.status(415).json({
          error: `Artifact extension is not editable from the dashboard (allowed: ${[...EDITABLE_ARTIFACT_EXTENSIONS].join(', ')})`,
        })
        return
      }

      const body = req.body as { content?: unknown } | undefined
      const content = body?.content
      if (typeof content !== 'string') {
        res.status(400).json({ error: 'Request body must include `content` as a string' })
        return
      }
      if (Buffer.byteLength(content, 'utf-8') > MAX_ARTIFACT_EDIT_BYTES) {
        res.status(413).json({ error: `Artifact body exceeds ${MAX_ARTIFACT_EDIT_BYTES} bytes` })
        return
      }

      const config = loadLocalConfig()
      const workingDir = resolveLocalWorkingDir(config)
      const jobWorkingDir = path.resolve(workingDir, jobId)
      const resolved = path.resolve(jobWorkingDir, rawPath)

      if (!resolved.startsWith(jobWorkingDir + path.sep) && resolved !== jobWorkingDir) {
        logger.warn({ jobId, artifactId, rawPath, resolved }, 'Artifact edit path escape attempt blocked')
        res.status(400).json({ error: 'Artifact path is outside the job working directory' })
        return
      }

      // Make sure the file the agent registered actually exists before we
      // accept an edit — refuse to create new files via this endpoint so we
      // never resurrect a deleted artefact target.
      try {
        await fs.promises.stat(resolved)
      } catch {
        res.status(404).json({ error: `Artifact file no longer exists: ${rawPath}` })
        return
      }

      await fs.promises.mkdir(path.dirname(resolved), { recursive: true })
      await fs.promises.writeFile(resolved, content, 'utf-8')

      const updatedArtifact = {
        ...artifact,
        editedAt: new Date().toISOString(),
        editedBy: 'developer',
      }
      const nextArtifacts = artifacts.slice()
      nextArtifacts[artifactIdx] = updatedArtifact
      await stateBackend.updateJob(jobId, { artifacts: nextArtifacts })
      await stateBackend.appendLog(
        jobId,
        `[artifact-edit] ${updatedArtifact.phase}/${updatedArtifact.kind}: developer edited ${rawPath}`,
      )

      res.json({ artifact: updatedArtifact })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ err, jobId, artifactId }, 'Artifact edit failed')
      res.status(500).json({ error: `Could not save artifact content: ${msg}` })
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

  app.post('/jobs/:jobId/pause', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined
      const updated = await dispatcher.pauseJob(jobId, reason)
      res.json({ paused: updated.id, status: updated.status, awaitingEvent: updated.awaitingEvent })
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

  // ── Insight curation ────────────────────────────────────────────────────
  //
  // Insights are recorded by agents via `add_insight` and surfaced in the
  // dashboard's Insights tab. Users can edit, approve, reject, or tag them
  // with a target layer (tenant/repo) before the evaluator phase ships
  // approved entries via `propose_change`.
  //
  // Backfill: legacy insights persisted before this feature lacked `id` /
  // `status`. We assign synthetic ids on first read and persist back so
  // subsequent PATCH/DELETE can address them.

  async function ensureInsightIds(jobId: string): Promise<Job> {
    const job = await stateBackend.getJob(jobId) as Job | null
    if (!job) throw Object.assign(new Error('Job not found'), { httpCode: 404 })
    const insights = job.insights ?? []
    let mutated = false
    const seen = new Set<string>()
    const backfilled: Insight[] = insights.map((ins, idx) => {
      let id = ins.id
      if (!id || seen.has(id)) {
        id = `ins-legacy-${idx}-${Math.random().toString(36).slice(2, 8)}`
        mutated = true
      }
      seen.add(id)
      const status: InsightStatus = ins.status ?? 'pending'
      if (status !== ins.status) mutated = true
      return { ...ins, id, status }
    })
    if (mutated) {
      await stateBackend.updateJob(jobId, { insights: backfilled })
      return (await stateBackend.getJob(jobId)) as Job
    }
    return job
  }

  app.get('/jobs/:jobId/insights', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const job = await ensureInsightIds(jobId)
      // By default, return ONLY this job's own insights. Campaign children
      // get sibling-inherited insights seeded into `job.insights` (tagged
      // with `sourceChildName`) so the prompt builder can surface them as
      // context — but those belong to the originating sibling's job page
      // for curation. Pass ?includeInherited=1 to opt back in (debugging).
      const includeInherited =
        req.query.includeInherited === '1' || req.query.includeInherited === 'true'
      const all = job.insights ?? []
      const insights = includeInherited ? all : all.filter((i) => !i.sourceChildName)
      res.json({ jobId, insights, inheritedCount: all.length - insights.length })
    } catch (err) {
      const e = err as Error & { httpCode?: number }
      res.status(e.httpCode ?? 400).json({ error: e.message })
    }
  })

  const ALLOWED_LAYERS: InsightLayer[] = ['tenant', 'repo']
  const ALLOWED_STATUSES: InsightStatus[] = ['pending', 'approved', 'rejected']

  app.patch('/jobs/:jobId/insights/:insightId', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const insightId = Array.isArray(req.params.insightId) ? req.params.insightId[0] : req.params.insightId
      const body = (req.body ?? {}) as {
        status?: unknown
        userLayer?: unknown
        editedSummary?: unknown
        editedDetail?: unknown
        editedSuggestion?: unknown
        editedBy?: unknown
      }

      if (body.status !== undefined && !ALLOWED_STATUSES.includes(body.status as InsightStatus)) {
        res.status(400).json({ error: `status must be one of ${ALLOWED_STATUSES.join(', ')}` })
        return
      }
      if (
        body.userLayer !== undefined &&
        body.userLayer !== null &&
        !ALLOWED_LAYERS.includes(body.userLayer as InsightLayer)
      ) {
        res.status(400).json({ error: `userLayer must be one of ${ALLOWED_LAYERS.join(', ')} or null` })
        return
      }
      for (const k of ['editedSummary', 'editedDetail', 'editedSuggestion', 'editedBy'] as const) {
        if (body[k] !== undefined && body[k] !== null && typeof body[k] !== 'string') {
          res.status(400).json({ error: `${k} must be a string when present` })
          return
        }
      }

      const job = await ensureInsightIds(jobId)
      const insights = [...(job.insights ?? [])]
      const idx = insights.findIndex((i) => i.id === insightId)
      if (idx < 0) { res.status(404).json({ error: 'Insight not found' }); return }

      const now = new Date().toISOString()
      const editor = typeof body.editedBy === 'string' && body.editedBy ? body.editedBy : 'dashboard-user'
      const prev = insights[idx]
      const next: Insight = { ...prev }

      let editTouched = false
      let decisionTouched = false

      if (body.status !== undefined && body.status !== prev.status) {
        next.status = body.status as InsightStatus
        decisionTouched = true
      }
      if (body.userLayer !== undefined) {
        if (body.userLayer === null) delete next.userLayer
        else next.userLayer = body.userLayer as InsightLayer
        decisionTouched = true
      }
      for (const k of ['editedSummary', 'editedDetail', 'editedSuggestion'] as const) {
        if (body[k] === undefined) continue
        const v = body[k]
        if (v === null || v === '') {
          if (next[k] !== undefined) { delete next[k]; editTouched = true }
        } else if (typeof v === 'string' && next[k] !== v) {
          next[k] = v
          editTouched = true
        }
      }

      if (editTouched) { next.editedBy = editor; next.editedAt = now }
      if (decisionTouched) { next.decidedBy = editor; next.decidedAt = now }

      insights[idx] = next
      const updated = await stateBackend.updateJob(jobId, { insights })
      res.json({ insight: next, totalInsights: updated.insights?.length ?? 0 })
    } catch (err) {
      const e = err as Error & { httpCode?: number }
      res.status(e.httpCode ?? 400).json({ error: e.message })
    }
  })

  // Soft-delete: maps to status='rejected' so we preserve the audit trail.
  // Pass ?hard=1 to actually remove the row.
  app.delete('/jobs/:jobId/insights/:insightId', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const insightId = Array.isArray(req.params.insightId) ? req.params.insightId[0] : req.params.insightId
      const hard = req.query.hard === '1' || req.query.hard === 'true'

      const job = await ensureInsightIds(jobId)
      const insights = [...(job.insights ?? [])]
      const idx = insights.findIndex((i) => i.id === insightId)
      if (idx < 0) { res.status(404).json({ error: 'Insight not found' }); return }

      const now = new Date().toISOString()
      if (hard) {
        insights.splice(idx, 1)
      } else {
        insights[idx] = {
          ...insights[idx],
          status: 'rejected',
          decidedBy: 'dashboard-user',
          decidedAt: now,
        }
      }
      const updated = await stateBackend.updateJob(jobId, { insights })
      res.json({ removed: hard, insightId, totalInsights: updated.insights?.length ?? 0 })
    } catch (err) {
      const e = err as Error & { httpCode?: number }
      res.status(e.httpCode ?? 400).json({ error: e.message })
    }
  })

  // ── Per-phase model overrides ───────────────────────────────────────────
  //
  // Dashboards (Job Detail "Phase strip") use these to pin a different
  // model for a single phase of a single job — without touching the
  // workflow file. The override lives on the Job and is consulted by
  // `runJob` next time the phase enters. Two endpoints:
  //
  //   PATCH /jobs/:id/phase-overrides — set/clear an override (no exec)
  //   POST  /jobs/:id/phases/:phase/rerun — set override + restart phase
  //
  // Phase names are validated against the job's resolved workflow so a
  // typo from a stale dashboard tab fails loud instead of silently
  // creating a no-op entry.

  app.patch('/jobs/:jobId/phase-overrides', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const { phase, model, provider, clear } = req.body ?? {}
      if (typeof phase !== 'string' || !phase) {
        res.status(400).json({ error: 'phase is required' })
        return
      }
      if (!clear && (typeof model !== 'string' || !model)) {
        res.status(400).json({ error: 'model is required unless clear=true' })
        return
      }
      if (provider !== undefined && typeof provider !== 'string') {
        res.status(400).json({ error: 'provider must be a string when present' })
        return
      }
      const updated = await dispatcher.setPhaseOverride(
        jobId,
        phase,
        clear ? null : { model, provider },
      )
      res.json({ phaseModelOverrides: updated.phaseModelOverrides ?? {} })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  app.post('/jobs/:jobId/phases/:phase/rerun', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const phase = Array.isArray(req.params.phase) ? req.params.phase[0] : req.params.phase
      if (!phase) { res.status(400).json({ error: 'phase is required' }); return }
      const { model, provider } = req.body ?? {}
      if (model !== undefined && typeof model !== 'string') {
        res.status(400).json({ error: 'model must be a string when present' })
        return
      }
      if (provider !== undefined && typeof provider !== 'string') {
        res.status(400).json({ error: 'provider must be a string when present' })
        return
      }
      const override = typeof model === 'string' && model
        ? { model, provider: typeof provider === 'string' ? provider : undefined }
        : undefined
      await dispatcher.rerunPhase(jobId, phase, override)
      res.json({ rerunning: true, phase })
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

      // Auto-derive `llm.defaultProvider` when the user has exactly one
      // executor plugin enabled in `plugins.installed` and has not yet
      // explicitly chosen a default. Without this, fresh installs that
      // completed claude-login still see "Missing: LLM provider" on the
      // Home banner because the readiness check only looks at the
      // explicit `defaultProvider` field, while the runner's resolver
      // would happily fall back to the sole installed executor at job
      // start. We synthesise here so the wire response matches runtime
      // behaviour. Persisted writes go through `pluginSavePluginConfig`
      // (further down), which sets the same field on disk so the value
      // survives once the user touches Settings.
      //
      // We treat an executor slot as "actually configured" when it is
      // enabled AND its `config` object has at least one key. This lets
      // us pick the right default when more than one executor plugin
      // ships built-in (e.g. anthropic + openai both auto-register as
      // `enabled: true`, but only the one the user filled in has any
      // config keys). Without this, the synthesis only fires when
      // exactly one executor is enabled, and the Home banner reports
      // "Missing: LLM provider" even though the user has a working
      // provider — because the other built-in still occupies an
      // enabled-but-empty slot.
      const enabledExecutorEntries = config
        ? Object.entries(config.plugins?.installed ?? {})
            .filter(([id, slot]) =>
              slot.enabled && BUILTIN_PLUGIN_IDS_BY_KIND.executor.includes(id),
            )
        : []
      const configuredExecutorIds = enabledExecutorEntries
        .filter(([, slot]) => Object.keys((slot.config ?? {}) as Record<string, unknown>).length > 0)
        .map(([id]) => id)
        .sort()
      const candidateExecutorIds = configuredExecutorIds.length > 0
        ? configuredExecutorIds
        : enabledExecutorEntries.map(([id]) => id).sort()
      // Pick the first candidate when one or more is available. Earlier
      // versions of this code only synthesised when exactly one
      // candidate existed, on the theory that picking between two
      // configured providers shouldn't be implicit. In practice the
      // runtime resolver already picks deterministically (first enabled
      // executor) when no defaultProvider is set, so the dashboard
      // banner was lying about a non-issue. Mirror the resolver's
      // pick-first behaviour here so the wire response matches what
      // jobs actually run on. The user can still override in Settings.
      const synthesisedDefaultProvider =
        config && !config.llm?.defaultProvider && candidateExecutorIds.length >= 1
          ? candidateExecutorIds[0]
          : undefined

      // Plugin-shape credentials (LLM, SCM, tracker) live under
      // `plugins.installed.<id>.config` and are redacted further down
      // via `redactPluginConfig` — the runner core no longer carries
      // per-provider redaction here.
      const safeConfig = config ? {
        ...config,
        llm: synthesisedDefaultProvider
          ? { ...(config.llm ?? {}), defaultProvider: synthesisedDefaultProvider }
          : config.llm,
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
        // Plugins (PluginsConfig). Each `installed[id].config` may
        // hold per-plugin secrets — redact field names that look
        // secret-shaped (token / apiKey / password / secret) so the
        // dashboard can hint that the value is set without ever
        // shipping the real credential. PUT restores via isRedacted().
        plugins: config.plugins
          ? {
              ...(config.plugins.defaults ? { defaults: config.plugins.defaults } : {}),
              installed: Object.fromEntries(
                Object.entries(config.plugins.installed ?? {}).map(([id, entry]) => [
                  id,
                  {
                    enabled: entry.enabled,
                    config: redactPluginConfig(entry.config as Record<string, unknown> | undefined),
                  },
                ]),
              ),
            }
          : undefined,
        guardrails: config.guardrails
          ? {
              ...(typeof config.guardrails.enabled === 'boolean'
                ? { enabled: config.guardrails.enabled }
                : {}),
              ...(config.guardrails.rules ? { rules: config.guardrails.rules } : {}),
            }
          : undefined,
      } : null

      const guardrailsResolved = resolveGuardrails(config?.guardrails ?? null).resolved

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
          guardrails: guardrailsResolved,
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

  app.put('/config', async (req: Request, res: Response) => {
    try {
      const updates = req.body
      if (!updates || typeof updates !== 'object') {
        res.status(400).json({ error: 'Request body must be a config object' })
        return
      }

      // Load existing, merge, save. We use loadLocalConfigRaw() so a
      // previously corrupt file doesn't block the save: if the on-disk JSON
      // fails schema validation, we treat the existing state as empty and
      // let the user overwrite it cleanly.
      const existingResult = loadLocalConfigRaw()
      const existing: LocalConfig =
        existingResult.kind === 'ok' ? existingResult.config : ({} as LocalConfig)
      const merged: LocalConfig = { ...existing }

      // Anthropic credentials are no longer accepted on this endpoint;
      // they live under `plugins.installed.anthropic.config` and are
      // managed via the plugins registry endpoints. The legacy top-level
      // `anthropic` block was removed in Phase F of the
      // Anthropic-as-plugin migration.

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

      // SCM credentials live under `plugins.installed.{github|bitbucket|
      // gitlab}.config` and are merged via the generic plugins branch
      // below — there is no longer a legacy top-level `git` block to
      // special-case here.

      // Respect local mode — strip cloud if not explicitly set
      if (!updates.cloud) {
        delete (merged as Record<string, unknown>).cloud
      }

      // Tracker credentials live under `plugins.installed.{jira|linear|
      // github-issues}.config` and are merged via the generic plugins
      // branch below — there is no longer a legacy top-level `tracker`
      // block to special-case here.

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

      // Plugins block. Replaces the legacy per-provider git/tracker
      // shape with a uniform `installed[id]` map. Each entry's
      // `config` is deep-merged per-key against the existing config
      // so partial saves only touch the keys the dashboard sent;
      // secret-shaped fields (token / apiKey / password / secret)
      // that come back as the redacted `...` placeholder fall through
      // to the on-disk value via mergePluginConfig().
      if (Object.prototype.hasOwnProperty.call(updates, 'plugins')) {
        const incoming = (updates as Record<string, unknown>)['plugins'] as
          | { defaults?: { scm?: string; tracker?: string }; installed?: Record<string, { enabled?: boolean; config?: Record<string, unknown> }> }
          | null
          | undefined
        if (incoming === null) {
          delete (merged as Record<string, unknown>).plugins
        } else if (incoming && typeof incoming === 'object') {
          const existingPlugins = existing.plugins ?? { installed: {} }
          const nextInstalled: Record<string, { enabled?: boolean; config: Record<string, unknown> }> = {
            ...(existingPlugins.installed ?? {}),
          }
          for (const [id, raw] of Object.entries(incoming.installed ?? {})) {
            if (!raw || typeof raw !== 'object') continue
            const prev = existingPlugins.installed?.[id]
            const mergedCfg = mergePluginConfig(
              prev?.config as Record<string, unknown> | undefined,
              raw.config,
            )
            nextInstalled[id] = {
              ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : prev?.enabled !== undefined ? { enabled: prev.enabled } : {}),
              config: mergedCfg,
            }
          }
          const nextDefaults = incoming.defaults
            ? { ...(existingPlugins.defaults ?? {}), ...incoming.defaults }
            : existingPlugins.defaults
          ;(merged as Record<string, unknown>).plugins = {
            ...(nextDefaults ? { defaults: nextDefaults } : {}),
            installed: nextInstalled,
          }
        }
      }

      // Setup (FTUE completion) — replace wholesale so the dashboard
      // can reset the flag by sending `null`. Validation happens via
      // the schema after merge.
      if (Object.prototype.hasOwnProperty.call(updates, 'setup')) {
        const incoming = (updates as Record<string, unknown>)['setup'] as
          | { completedAt?: string; skipped?: Array<'llm' | 'scm' | 'tracker'> }
          | null
          | undefined
        if (incoming === null) {
          delete (merged as Record<string, unknown>).setup
        } else if (incoming && typeof incoming === 'object') {
          const next: NonNullable<LocalConfig['setup']> = {}
          if (typeof incoming.completedAt === 'string' && incoming.completedAt.length > 0) {
            next.completedAt = incoming.completedAt
          }
          if (Array.isArray(incoming.skipped)) {
            next.skipped = incoming.skipped.filter(
              (s): s is 'llm' | 'scm' | 'tracker' =>
                s === 'llm' || s === 'scm' || s === 'tracker',
            )
          }
          if (Object.keys(next).length > 0) {
            ;(merged as Record<string, unknown>).setup = next
          } else {
            delete (merged as Record<string, unknown>).setup
          }
        }
      }

      if (Object.prototype.hasOwnProperty.call(updates, 'coachMode')) {
        const incoming = (updates as Record<string, unknown>)['coachMode'] as
          | NonNullable<LocalConfig['coachMode']>
          | null
          | undefined
        if (incoming === null) {
          delete (merged as Record<string, unknown>).coachMode
        } else if (incoming && typeof incoming === 'object') {
          const next: NonNullable<LocalConfig['coachMode']> = {
            ...(existing.coachMode ?? {}),
          }
          if (typeof incoming.enabled === 'boolean') next.enabled = incoming.enabled
          if (typeof incoming.graduateAfterRuns === 'number' && incoming.graduateAfterRuns >= 1) {
            next.graduateAfterRuns = incoming.graduateAfterRuns
          }
          if (typeof incoming.totalRuns === 'number' && incoming.totalRuns >= 0) {
            next.totalRuns = incoming.totalRuns
          }
          if (typeof incoming.lastRunAt === 'string') next.lastRunAt = incoming.lastRunAt
          if (typeof incoming.graduatedAt === 'string') next.graduatedAt = incoming.graduatedAt
          ;(merged as Record<string, unknown>).coachMode = next
        }
      }

      if (Object.prototype.hasOwnProperty.call(updates, 'intake')) {
        const incoming = (updates as Record<string, unknown>)['intake'] as
          | NonNullable<LocalConfig['intake']>
          | null
          | undefined
        if (incoming === null) {
          delete (merged as Record<string, unknown>).intake
        } else if (incoming && typeof incoming === 'object') {
          const next: NonNullable<LocalConfig['intake']> = {
            ...(existing.intake ?? {}),
          }
          if (incoming.mode === 'ai' || incoming.mode === 'form' || incoming.mode === 'ask-each-time') {
            next.mode = incoming.mode
          }
          ;(merged as Record<string, unknown>).intake = next
        }
      }

      // Guardrails — overrides merged at runtime with bundled defaults.
      if (Object.prototype.hasOwnProperty.call(updates, 'guardrails')) {
        const incoming = (updates as Record<string, unknown>)['guardrails'] as
          | { enabled?: boolean; rules?: LocalConfig['guardrails'] extends infer G ? G extends { rules?: infer R } ? R : never : never }
          | null
          | undefined
        if (incoming === null) {
          delete (merged as Record<string, unknown>).guardrails
        } else if (incoming && typeof incoming === 'object') {
          const next: NonNullable<LocalConfig['guardrails']> = {
            ...(existing.guardrails ?? {}),
          }
          if (typeof incoming.enabled === 'boolean') next.enabled = incoming.enabled
          if (Array.isArray(incoming.rules)) next.rules = incoming.rules
          ;(merged as Record<string, unknown>).guardrails = next
        }
      }

      // LLM block (multi-provider routing). Holds only the
      // `defaultProvider` selection and `aliases` map; provider configs
      // (auth, etc.) live under `plugins.installed.<id>.config` and are
      // saved via the `plugins` branch above. The dashboard sends the
      // full block back so we can replace wholesale rather than merge.
      if (Object.prototype.hasOwnProperty.call(updates, 'llm')) {
        const incoming = (updates as Record<string, unknown>)['llm'] as
          | { defaultProvider?: string; aliases?: Record<string, { provider: string; model: string; reasoningEffort?: 'low' | 'medium' | 'high' }> }
          | null
          | undefined
        if (incoming === null) {
          delete (merged as Record<string, unknown>).llm
        } else if (incoming && typeof incoming === 'object') {
          const next: NonNullable<LocalConfig['llm']> = {}
          if (typeof incoming.defaultProvider === 'string' && incoming.defaultProvider.length > 0) {
            next.defaultProvider = incoming.defaultProvider
          }
          if (incoming.aliases && typeof incoming.aliases === 'object') {
            const aliases: NonNullable<NonNullable<LocalConfig['llm']>['aliases']> = {}
            for (const [k, v] of Object.entries(incoming.aliases)) {
              if (!v || typeof v !== 'object') continue
              if (typeof v.provider !== 'string' || typeof v.model !== 'string') continue
              aliases[k] = {
                provider: v.provider,
                model: v.model,
                ...(v.reasoningEffort ? { reasoningEffort: v.reasoningEffort } : {}),
              }
            }
            if (Object.keys(aliases).length > 0) next.aliases = aliases
          }
          if (Object.keys(next).length > 0) {
            ;(merged as Record<string, unknown>).llm = next
          } else {
            delete (merged as Record<string, unknown>).llm
          }
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

      // Hot-reload the in-memory state so the next job (and the
      // dashboard's "Test connection" probes) immediately uses the
      // freshly-saved credentials. Failures are surfaced in the
      // response payload as `reload.failed` but never block the
      // save — the JSON is already on disk.
      const reload = await reloadInMemoryState()
      res.json({
        saved: true,
        configPath: defaultConfigPath(),
        ...(reload ? { reload } : {}),
      })
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

  // ── Git connection-test sub-checks ──────────────────────────────────────
  //
  // The legacy implementation just hit `/user` on the provider and
  // called it a day. That misses the failure modes that actually
  // break agents at runtime — wrong workspace, missing scopes, and
  // (for Bitbucket) the asymmetric git-over-HTTPS authentication
  // requirement where REST accepts the user's email but git requires
  // `x-bitbucket-api-token-auth` for the same ATATT token. See
  // `packages/runner/src/plugins/builtin/bitbucket/index.ts`
  // (`deriveGitUsername`) for the asymmetry rationale.
  //
  // The strengthened tests return a structured list of checks so the
  // dashboard can show the user exactly which step failed and how to
  // fix it before any job runs and 401s mid-clone or mid-PR-open.

  interface GitTestCheck {
    name: string
    ok: boolean
    message: string
    hint?: string
  }
  interface GitTestResponse {
    ok: boolean
    message: string
    checks: GitTestCheck[]
  }

  // Express's `Response` is in scope as the route handler's res
  // parameter; use the global fetch `Response` via this alias so the
  // helper signatures don't collide.
  type FetchResponse = globalThis.Response

  /** Short-form HTTP detail for a non-200 response. */
  async function describeHttpFailure(r: FetchResponse): Promise<string> {
    const text = await r.text().catch(() => '')
    const trimmed = text.trim().slice(0, 200)
    if (trimmed.length > 0) return `${r.status}: ${trimmed}`
    return `${r.status} ${r.statusText || ''}`.trim()
  }

  /**
   * Hit Bitbucket's smart-HTTP info/refs endpoint with Basic auth.
   * This is the one check that catches the email-vs-x-bitbucket-api-token-auth
   * asymmetry — REST may return 200 while git-over-HTTPS returns 401
   * (or vice versa) for the same token. Without this probe the user
   * discovers the mismatch only when an agent's `git push` fails.
   */
  async function probeGitHttps(
    repoCloneBase: string,
    gitUsername: string,
    token: string,
  ): Promise<{ ok: boolean; detail: string }> {
    const url = `${trimSlash(repoCloneBase)}/info/refs?service=git-upload-pack`
    const auth = Buffer.from(`${gitUsername}:${token}`).toString('base64')
    try {
      const r = await fetch(url, {
        headers: {
          Authorization: `Basic ${auth}`,
          'User-Agent': 'git/2.40.0',
          // Required by the smart-HTTP protocol; servers reject the
          // request otherwise even with valid creds.
          Accept: 'application/x-git-upload-pack-advertisement',
        },
      })
      if (r.ok) {
        const ct = r.headers.get('content-type') ?? ''
        if (!ct.includes('git-upload-pack-advertisement')) {
          return { ok: false, detail: `${r.status} but unexpected content-type "${ct}"` }
        }
        return { ok: true, detail: `${r.status} (git smart-HTTP handshake accepted)` }
      }
      return { ok: false, detail: await describeHttpFailure(r) }
    } catch (err) {
      return { ok: false, detail: (err as Error).message }
    }
  }

  /**
   * Atlassian API tokens (`ATATT…`) come in two flavours that the
   * prefix alone cannot distinguish: id.atlassian.com account API
   * tokens (REST + git want `email`) and Bitbucket-scoped API tokens
   * (REST + git want `x-bitbucket-api-token-auth`). When the user's
   * configured username fails the REST probe, try the alternate and
   * recommend the swap if it works.
   */
  async function tryAlternateBitbucketUsername(
    typedUsername: string,
    token: string,
  ): Promise<{ alternate: string; works: boolean } | null> {
    const isEmail = typedUsername.includes('@')
    const isSynthetic = /^x-[\w-]+-auth$/.test(typedUsername)
    // Only swap when the typed value is recognisably one of the two
    // shapes — random strings get no second chance.
    let alternate: string | null = null
    if (isEmail) alternate = 'x-bitbucket-api-token-auth'
    else if (isSynthetic) {
      const fromCfg = existingGitUsername()
      if (fromCfg && fromCfg.includes('@')) alternate = fromCfg
    }
    if (!alternate) return null
    const auth = Buffer.from(`${alternate}:${token}`).toString('base64')
    try {
      const r = await fetch('https://api.bitbucket.org/2.0/user', {
        headers: { Authorization: `Basic ${auth}`, 'User-Agent': 'coro-runner' },
      })
      return { alternate, works: r.ok }
    } catch {
      return { alternate, works: false }
    }
  }

  /**
   * Read the saved BitBucket coderUsername from the installed plugin
   * config. We use it as the alternate-username candidate when the
   * typed username is the synthetic `x-*-auth` form (we have no other
   * way to guess the user's email).
   */
  function existingGitUsername(): string | undefined {
    const cfg = loadLocalConfig()
    const bb = cfg?.plugins?.installed?.['bitbucket']?.config as
      | { coderUsername?: string }
      | undefined
    return bb?.coderUsername || undefined
  }

  /** Apply `deriveGitUsername` semantics here without importing from the plugin. */
  function deriveBitbucketGitUsername(typedUsername: string, token: string): string {
    const isAtlassianApiToken = token.startsWith('ATATT')
    const isEmail = typedUsername.includes('@')
    if (isAtlassianApiToken && isEmail) return 'x-bitbucket-api-token-auth'
    return typedUsername
  }

  async function runBitbucketTest(args: {
    username: string
    token: string
    workspace: string
    reviewerUsername?: string
    reviewerToken?: string
  }): Promise<GitTestResponse> {
    const checks: GitTestCheck[] = []
    const { username, token, workspace } = args
    if (!username) {
      return {
        ok: false,
        message: 'Bitbucket requires a username for Basic auth.',
        checks: [{ name: 'inputs', ok: false, message: 'Username is empty.' }],
      }
    }
    if (!workspace) {
      checks.push({
        name: 'inputs',
        ok: false,
        message: 'Workspace slug is empty — agents will not be able to clone or push.',
      })
    }

    // 1. REST auth with the user's typed username.
    const auth = Buffer.from(`${username}:${token}`).toString('base64')
    const restR = await fetch('https://api.bitbucket.org/2.0/user', {
      headers: { Authorization: `Basic ${auth}`, 'User-Agent': 'coro-runner' },
    })
    if (restR.ok) {
      const data = (await restR.json()) as { username?: string; display_name?: string }
      checks.push({
        name: 'REST auth (coder)',
        ok: true,
        message: `Authenticated as ${data.display_name ?? data.username ?? username}.`,
      })
    } else {
      const detail = await describeHttpFailure(restR)
      const alt = await tryAlternateBitbucketUsername(username, token)
      const hint = alt?.works
        ? `Your token authenticates as "${alt.alternate}", not "${username}". ` +
          `Change "coderUsername" to "${alt.alternate}" — Atlassian's two ATATT token types share the prefix but accept different usernames.`
        : 'Verify the token is correct and that it matches the username (email for id.atlassian.com API tokens; `x-bitbucket-api-token-auth` for Bitbucket-scoped tokens).'
      return {
        ok: false,
        message: `Bitbucket REST auth failed (${detail}).`,
        checks: [
          ...checks,
          { name: 'REST auth (coder)', ok: false, message: detail, hint },
        ],
      }
    }

    // 2. Workspace access — agents always scope to this workspace,
    //    so a 403/404 here breaks every subsequent tool call.
    if (workspace) {
      const wsR = await fetch(
        `https://api.bitbucket.org/2.0/workspaces/${encodeURIComponent(workspace)}`,
        { headers: { Authorization: `Basic ${auth}`, 'User-Agent': 'coro-runner' } },
      )
      checks.push({
        name: 'Workspace access',
        ok: wsR.ok,
        message: wsR.ok
          ? `Workspace "${workspace}" is reachable.`
          : `Cannot read workspace "${workspace}" (${await describeHttpFailure(wsR)}).`,
        hint: wsR.ok
          ? undefined
          : 'Check the slug (case-sensitive) and that the token has access to this workspace.',
      })
    }

    // 3. Repo listing — confirms the token has at least the repo:read
    //    scope and gives us a real repo slug to use for the git-HTTPS
    //    probe below.
    let sampleRepoSlug: string | undefined
    if (workspace) {
      const repoR = await fetch(
        `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspace)}?pagelen=1&fields=values.slug,values.full_name`,
        { headers: { Authorization: `Basic ${auth}`, 'User-Agent': 'coro-runner' } },
      )
      if (repoR.ok) {
        const data = (await repoR.json()) as { values?: Array<{ slug?: string; full_name?: string }> }
        sampleRepoSlug = data.values?.[0]?.slug
        checks.push({
          name: 'Repository scope',
          ok: true,
          message: sampleRepoSlug
            ? `Token can list repositories (sampled "${data.values?.[0]?.full_name}").`
            : 'Token can list repositories, but the workspace currently has none.',
        })
      } else {
        checks.push({
          name: 'Repository scope',
          ok: false,
          message: `Cannot list repos in "${workspace}" (${await describeHttpFailure(repoR)}).`,
          hint: 'The token likely lacks the `repository:read` scope.',
        })
      }
    }

    // 4. Git-over-HTTPS smart-protocol probe — THIS is the check
    //    that catches the email-vs-x-bitbucket-api-token-auth mismatch
    //    even when the REST probe passes. Without it, the user
    //    discovers the mismatch only when an agent's `git push` 401s.
    if (sampleRepoSlug && workspace) {
      const gitUsername = deriveBitbucketGitUsername(username, token)
      const probe = await probeGitHttps(
        `https://bitbucket.org/${workspace}/${sampleRepoSlug}.git`,
        gitUsername,
        token,
      )
      checks.push({
        name: 'Git over HTTPS',
        ok: probe.ok,
        message: probe.ok
          ? `git clone/push will authenticate as "${gitUsername}" (${probe.detail}).`
          : `git smart-HTTP handshake failed for "${gitUsername}" (${probe.detail}).`,
        hint: probe.ok
          ? undefined
          : gitUsername === username
            ? 'For Atlassian API tokens, git over HTTPS often needs `x-bitbucket-api-token-auth` as the username even though REST accepted your email.'
            : 'Coro automatically rewrites the git username for ATATT tokens. If this still fails, the token may be a Bitbucket-scoped token that needs the literal configured username.',
      })
    }

    // 5. Reviewer creds (only if separately configured) — agents
    //    that run the review phase will use these to approve PRs.
    if (args.reviewerToken && args.reviewerToken !== token) {
      const revUsername = (args.reviewerUsername ?? '').trim() || username
      const revAuth = Buffer.from(`${revUsername}:${args.reviewerToken}`).toString('base64')
      const revR = await fetch('https://api.bitbucket.org/2.0/user', {
        headers: { Authorization: `Basic ${revAuth}`, 'User-Agent': 'coro-runner' },
      })
      if (revR.ok) {
        const revData = (await revR.json()) as { username?: string; display_name?: string; uuid?: string }
        // Compare reviewer identity against coder — Bitbucket refuses
        // self-approval, so configuring the same account for both
        // silently breaks the review phase.
        const coderData = restR.ok ? ((await restR.clone().json().catch(() => ({}))) as { uuid?: string }) : {}
        const sameAccount = revData.uuid && coderData.uuid && revData.uuid === coderData.uuid
        checks.push({
          name: 'REST auth (reviewer)',
          ok: !sameAccount,
          message: sameAccount
            ? `Reviewer is the same Bitbucket account as the coder — Bitbucket forbids self-approval, the review phase will hang.`
            : `Authenticated as ${revData.display_name ?? revData.username ?? revUsername}.`,
          hint: sameAccount ? 'Use a separate Bitbucket account (or no reviewer at all) for the reviewer credentials.' : undefined,
        })
      } else {
        checks.push({
          name: 'REST auth (reviewer)',
          ok: false,
          message: `Reviewer auth failed (${await describeHttpFailure(revR)}).`,
          hint: 'Same rules as coder username — see the REST auth hint above.',
        })
      }
    }

    const ok = checks.every(c => c.ok)
    return {
      ok,
      message: ok
        ? 'Bitbucket credentials are ready for agent use.'
        : 'Bitbucket credentials have problems — see check details.',
      checks,
    }
  }

  async function runGithubTest(args: { owner: string; token: string; workspace: string }): Promise<GitTestResponse> {
    const checks: GitTestCheck[] = []
    const { token } = args
    const owner = args.owner || args.workspace

    // 1. Auth + scope discovery in one call.
    const userR = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'coro-runner',
      },
    })
    if (!userR.ok) {
      const detail = await describeHttpFailure(userR)
      return {
        ok: false,
        message: `GitHub auth failed (${detail}).`,
        checks: [{ name: 'REST auth', ok: false, message: detail }],
      }
    }
    const userData = (await userR.json()) as { login?: string }
    checks.push({
      name: 'REST auth',
      ok: true,
      message: `Authenticated as ${userData.login ?? '(unknown)'}.`,
    })

    // 2. Token scopes — `repo` is required for the agent to push,
    //    open PRs, and post review comments on private repos.
    const scopesHeader = userR.headers.get('x-oauth-scopes')
    if (scopesHeader === null) {
      // Fine-grained PAT or GitHub App token — scopes aren't reported
      // via this header. We can't verify; pass through with a note.
      checks.push({
        name: 'Token scopes',
        ok: true,
        message: 'Fine-grained or app token (scopes not introspectable via REST).',
      })
    } else {
      const scopes = scopesHeader.split(',').map(s => s.trim()).filter(Boolean)
      const hasRepo = scopes.includes('repo') || scopes.includes('public_repo')
      checks.push({
        name: 'Token scopes',
        ok: hasRepo,
        message: hasRepo
          ? `Has scope${scopes.length === 1 ? '' : 's'}: ${scopes.join(', ')}.`
          : `Missing "repo" scope (got: ${scopes.join(', ') || 'none'}).`,
        hint: hasRepo
          ? undefined
          : 'Agents need the `repo` scope to push branches, open PRs, and post review comments.',
      })
    }

    // 3. Owner access — `owner` may be the same as login (user) or an
    //    org. Probe whichever endpoint matches.
    if (owner && owner.toLowerCase() !== (userData.login ?? '').toLowerCase()) {
      const orgR = await fetch(`https://api.github.com/orgs/${encodeURIComponent(owner)}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'coro-runner',
        },
      })
      if (orgR.ok) {
        checks.push({ name: 'Owner access', ok: true, message: `Org "${owner}" is reachable.` })
      } else {
        const detail = await describeHttpFailure(orgR)
        checks.push({
          name: 'Owner access',
          ok: false,
          message: `Cannot read org/owner "${owner}" (${detail}).`,
          hint: 'Verify the owner slug and that the token is authorised for the org (SSO may require explicit token approval).',
        })
      }
    }

    // 4. Git-over-HTTPS probe against the user's own profile repos
    //    endpoint to confirm credential format works for git, not just
    //    for the REST API. GitHub uses `x-access-token:TOKEN` for
    //    bearer-style PATs — we mirror what `cloneInfo()` builds.
    const repoListR = await fetch(
      `https://api.github.com/users/${encodeURIComponent(owner || userData.login || '')}/repos?per_page=1&type=owner`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'coro-runner',
        },
      },
    )
    if (repoListR.ok) {
      const repos = (await repoListR.json()) as Array<{ name?: string; full_name?: string }>
      const sample = repos[0]?.full_name
      if (sample) {
        const probe = await probeGitHttps(`https://github.com/${sample}.git`, 'x-access-token', token)
        checks.push({
          name: 'Git over HTTPS',
          ok: probe.ok,
          message: probe.ok
            ? `git clone/push will work for ${sample} (${probe.detail}).`
            : `git smart-HTTP handshake failed (${probe.detail}).`,
          hint: probe.ok ? undefined : 'Token likely lacks `repo` scope for git operations.',
        })
      }
    }

    const ok = checks.every(c => c.ok)
    return {
      ok,
      message: ok
        ? 'GitHub credentials are ready for agent use.'
        : 'GitHub credentials have problems — see check details.',
      checks,
    }
  }

  async function runGitlabTest(args: { token: string; workspace: string }): Promise<GitTestResponse> {
    const checks: GitTestCheck[] = []
    const r = await fetch('https://gitlab.com/api/v4/user', {
      headers: { 'PRIVATE-TOKEN': args.token, 'User-Agent': 'coro-runner' },
    })
    if (!r.ok) {
      const detail = await describeHttpFailure(r)
      return {
        ok: false,
        message: `GitLab auth failed (${detail}).`,
        checks: [{ name: 'REST auth', ok: false, message: detail }],
      }
    }
    const data = (await r.json()) as { username?: string; name?: string }
    checks.push({
      name: 'REST auth',
      ok: true,
      message: `Authenticated as ${data.name ?? data.username ?? '(unknown)'}.`,
    })

    if (args.workspace) {
      const gR = await fetch(
        `https://gitlab.com/api/v4/groups/${encodeURIComponent(args.workspace)}`,
        { headers: { 'PRIVATE-TOKEN': args.token, 'User-Agent': 'coro-runner' } },
      )
      checks.push({
        name: 'Group access',
        ok: gR.ok,
        message: gR.ok
          ? `Group "${args.workspace}" is reachable.`
          : `Cannot read group "${args.workspace}" (${await describeHttpFailure(gR)}).`,
      })
    }

    const ok = checks.every(c => c.ok)
    return {
      ok,
      message: ok ? 'GitLab credentials are ready for agent use.' : 'GitLab credentials have problems.',
      checks,
    }
  }

  app.post('/test/git', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        provider?: string
        username?: string
        token?: string
        workspace?: string
        reviewerUsername?: string
        reviewerToken?: string
      }
      const provider = body.provider
      if (provider !== 'github' && provider !== 'bitbucket' && provider !== 'gitlab') {
        res.status(400).json({ ok: false, message: `Unsupported git provider "${provider}"` })
        return
      }

      // Plugin-installed creds are the single source of truth. The
      // dashboard may send `...`-redacted secrets on round-trip when
      // the user only changed non-secret fields; in that case we fill
      // in from the persisted plugin config.
      const existing = loadLocalConfig()
      const ghInstalled = existing?.plugins?.installed?.['github']?.config as
        | { owner?: string; token?: string }
        | undefined
      const bbInstalled = existing?.plugins?.installed?.['bitbucket']?.config as
        | {
            workspace?: string
            coderUsername?: string
            coderToken?: string
            reviewerUsername?: string
            reviewerToken?: string
          }
        | undefined
      const glInstalled = existing?.plugins?.installed?.['gitlab']?.config as
        | { token?: string; workspace?: string }
        | undefined

      // Per-provider fallback for `username` (BitBucket: coderUsername;
      // GitHub: the owner is sent as `username` from the wizard since
      // both REST and git basic-auth use a placeholder username on GitHub).
      const fallbackUsername =
        provider === 'bitbucket' ? bbInstalled?.coderUsername
        : provider === 'github' ? ghInstalled?.owner
        : ''
      const fallbackToken =
        provider === 'bitbucket' ? bbInstalled?.coderToken
        : provider === 'github' ? ghInstalled?.token
        : glInstalled?.token
      const fallbackWorkspace =
        provider === 'bitbucket' ? bbInstalled?.workspace
        : provider === 'gitlab' ? glInstalled?.workspace
        : ''

      const username = (body.username ?? fallbackUsername ?? '').trim()
      const token = resolveSecret(body.token, fallbackToken)
      const workspace = (body.workspace ?? fallbackWorkspace ?? '').trim()
      if (!token) {
        res.json({ ok: false, message: 'Token is required.', checks: [] })
        return
      }

      const result =
        provider === 'github'
          ? await runGithubTest({ owner: username, token, workspace })
          : provider === 'bitbucket'
            ? await runBitbucketTest({
                username,
                token,
                workspace,
                reviewerUsername:
                  ((body.reviewerUsername ?? '').trim() || bbInstalled?.reviewerUsername) || undefined,
                reviewerToken:
                  resolveSecret(body.reviewerToken, bbInstalled?.reviewerToken) || undefined,
              })
            : await runGitlabTest({ token, workspace })

      res.json(result)
    } catch (err) {
      logger.warn({ err }, 'POST /test/git failed')
      res.json({ ok: false, message: (err as Error).message, checks: [] })
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
      // Plugin-installed creds are the single source of truth. The
      // dashboard may send `...`-redacted secrets on round-trip when
      // the user only changed non-secret fields; in that case we fill
      // in from the persisted plugin config.
      const jiraInstalled = existing?.plugins?.installed?.['jira']?.config as
        | { baseUrl?: string; username?: string; apiToken?: string }
        | undefined
      const linearInstalled = existing?.plugins?.installed?.['linear']?.config as
        | { apiKey?: string; teamKey?: string }
        | undefined
      const ghIssuesInstalled = existing?.plugins?.installed?.['github-issues']?.config as
        | { token?: string; defaultOwner?: string }
        | undefined
      const ghInstalled = existing?.plugins?.installed?.['github']?.config as
        | { owner?: string; token?: string }
        | undefined

      if (provider === 'jira') {
        const baseUrl = (body.jira?.baseUrl ?? jiraInstalled?.baseUrl ?? '').trim()
        const username = (body.jira?.username ?? jiraInstalled?.username ?? '').trim()
        const apiToken = resolveSecret(body.jira?.apiToken, jiraInstalled?.apiToken)
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
        const apiKey = resolveSecret(body.linear?.apiKey, linearInstalled?.apiKey)
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

      if (provider === 'github' || provider === 'github-issues') {
        // GitHub Issues is its own plugin (`github-issues`) carrying
        // its own token. We accept either an inline `token` field or
        // the catalogue's `git.{ username, token }` envelope, both of
        // which the dashboard's tracker-test payload may send during
        // initial wiring. Credentials fall back to the installed
        // github-issues plugin config, then to the (also-plugin-shape)
        // github SCM plugin's token as a last resort.
        const username = (body.git?.username ?? ghInstalled?.owner ?? ghIssuesInstalled?.defaultOwner ?? '').trim()
        const token = resolveSecret(
          body.git?.token ?? (body as { token?: string }).token,
          ghIssuesInstalled?.token ?? ghInstalled?.token,
        )
        if (!token) {
          res.json({ ok: false, message: 'GitHub token is required (set it in Source control or under GitHub Issues).' })
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

  // POST /test/llm — Live credential probe for executor (LLM) plugins,
  // used by the Settings page and the FTUE wizard. Pure dispatcher:
  // the runner core knows nothing about Anthropic / OpenAI / Foundry
  // auth shapes. Each LLM plugin owns its own probe via the optional
  // `PluginRuntime.testConnection(config)` method declared on
  // `@coro-ai/plugin-sdk`. Plugins that don't implement it fall back to
  // the cheaper `healthcheck()` — the right default for "config-only"
  // providers whose only check is "is the required field non-empty".
  //
  // The dashboard ships a redacted form of any secret it has already
  // seen (`'…'`). We deep-merge the incoming draft over the on-disk
  // config so the plugin always receives the real credential to probe
  // with — without the dashboard ever transporting the real secret.
  app.post('/test/llm', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        provider?: string
        config?: Record<string, unknown>
      }
      const provider = body.provider
      if (!provider || typeof provider !== 'string') {
        res.status(400).json({ ok: false, message: 'provider is required' })
        return
      }
      const runtime = plugins?.byId(provider)
      if (!runtime) {
        res.status(404).json({ ok: false, message: `Unknown executor plugin "${provider}"` })
        return
      }
      const merged = mergePluginConfigForProbe(provider, body.config ?? {})

      if (typeof runtime.testConnection === 'function') {
        const result = await runtime.testConnection(merged)
        res.json(result)
        return
      }

      // Plugin hasn't been updated to expose an active probe. Best
      // effort: surface the shape-only healthcheck as a result so the
      // dashboard can still render *something* useful.
      const health = await runtime.healthcheck()
      res.json({
        ok: health.ok,
        message: health.ok
          ? `${runtime.manifest.displayName} is configured.`
          : (health.reason ?? `${runtime.manifest.displayName} is not configured.`),
      })
    } catch (err) {
      logger.warn({ err }, 'POST /test/llm failed')
      res.json({ ok: false, message: (err as Error).message })
    }
  })

  /**
   * Merge an incoming draft plugin config with the on-disk config so
   * `testConnection` always receives the real secret instead of the
   * `'…'` redaction the dashboard echoes back. Recursive so nested
   * objects (Anthropic's `account`, OpenAI's transports) merge too.
   */
  function mergePluginConfigForProbe(
    providerId: string,
    draft: Record<string, unknown>,
  ): Record<string, unknown> {
    const existing = loadLocalConfig()
    const onDisk = (existing?.plugins?.installed?.[providerId]?.config ?? {}) as Record<string, unknown>
    return mergeWithRedactionFill(onDisk, draft)
  }

  function mergeWithRedactionFill(
    onDisk: Record<string, unknown>,
    draft: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...onDisk }
    for (const [key, draftValue] of Object.entries(draft)) {
      const diskValue = onDisk[key]
      if (isRedacted(draftValue)) {
        if (diskValue !== undefined) out[key] = diskValue
        continue
      }
      if (
        draftValue &&
        typeof draftValue === 'object' &&
        !Array.isArray(draftValue) &&
        diskValue &&
        typeof diskValue === 'object' &&
        !Array.isArray(diskValue)
      ) {
        out[key] = mergeWithRedactionFill(
          diskValue as Record<string, unknown>,
          draftValue as Record<string, unknown>,
        )
        continue
      }
      out[key] = draftValue
    }
    return out
  }

  // ── Plugin-registered HTTP routes ───────────────────────────────────────
  //
  // Provider-specific endpoints (Anthropic OAuth login, future OpenAI
  // callbacks, etc.) live inside their owning plugin and are mounted
  // here via the `PluginRuntime.registerHttpRoutes` hook. The runner
  // core has no knowledge of which provider routes exist — adding a
  // new LLM plugin requires zero changes in this file.
  // Use the same `lateMountPlugin` closure as the hot-reload path so
  // boot and runtime route registration share semantics — auto-elect
  // default LLM, redaction, and error handling all flow through one
  // place.
  if (plugins) {
    for (const runtime of plugins.all()) {
      lateMountPlugin(runtime)
    }
  }

  // ── Dashboard (served under /dashboard/) ───────────────────────────────
  //
  // The dashboard now lives in a sibling workspace package (`@coro-ai/dashboard`),
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
        hint: 'Run `pnpm --filter @coro-ai/dashboard build` or set CORO_DASHBOARD_DIST.',
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
