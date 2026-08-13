// ── Local filesystem SCM plugin ───────────────────────────────────────────────
//
// Zero-config first jobs against an existing git checkout on disk. Simulates
// PR lifecycle via JSON records; delivers work as a pushed branch.

import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Logger } from 'pino'
import type { ExternalRef, NormalizedEvent } from '@coro-ai/cloud-protocol'
import type {
  PluginDeps,
  PluginHealth,
  PluginManifest,
  ScmCloneInfo,
  ScmCreatePrArgs,
  ScmPluginRuntime,
  ScmPollSnapshot,
  ScmPrComment,
  ScmPrStatus,
} from '../../types'

const localConfigSchema = z.object({}).passthrough()

type LocalPrRecord = {
  id: string
  title: string
  sourceBranch: string
  targetBranch: string
  state: 'open' | 'merged' | 'declined' | 'superseded'
  approvalCount: number
  comments: ScmPrComment[]
}

const MANIFEST: PluginManifest = {
  id: 'local',
  kind: 'scm',
  version: '1.0.0',
  displayName: 'Local repository',
  hostCompatibility: '^1.0.0',
  configSchema: localConfigSchema,
  capabilities: {
    supportsRepoCreation: false,
    supportsApproval: true,
    supportsMerge: true,
  },
  ui: {
    subtitle: 'Work on local repositories — no account needed.',
    recommendedForOnboarding: true,
  },
  auth: {
    methods: [
      {
        kind: 'form',
        id: 'enable',
        label: 'Enable local mode',
        recommended: true,
        fields: [],
      },
    ],
  },
}

function storePath(repoKey: string): string {
  const slug = repoKey.replace(/[^\w.-]+/g, '_')
  return path.join(os.homedir(), '.coro', 'local-scm', `${slug}.json`)
}

function readStore(repoKey: string): LocalPrRecord[] {
  const file = storePath(repoKey)
  if (!fs.existsSync(file)) return []
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as LocalPrRecord[]
  } catch {
    return []
  }
}

function writeStore(repoKey: string, records: LocalPrRecord[]): void {
  const file = storePath(repoKey)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(records, null, 2))
}

function assertGitRepo(repoPath: string): void {
  if (!path.isAbsolute(repoPath)) {
    throw new Error(`local scm: repo path must be absolute: ${repoPath}`)
  }
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    throw new Error(`local scm: not a git repository: ${repoPath}`)
  }
}

class LocalScmPlugin implements ScmPluginRuntime {
  readonly manifest = MANIFEST
  readonly kind = 'scm' as const

  async init(_config: Record<string, unknown>, _deps: PluginDeps): Promise<void> {}

  async healthcheck(): Promise<PluginHealth> {
    return { ok: true }
  }

  async dispose(): Promise<void> {}

  cloneInfo(args: { repo: string }): ScmCloneInfo {
    assertGitRepo(args.repo)
    return { url: args.repo, envForGit: {} }
  }

  matchesRemote(remoteUrl: string): boolean {
    if (remoteUrl.startsWith('file://')) return true
    return path.isAbsolute(remoteUrl)
  }

  async createPr(args: ScmCreatePrArgs): Promise<ExternalRef> {
    return this.writerCreatePr(args)
  }

  async writerCreatePr(args: ScmCreatePrArgs): Promise<ExternalRef> {
    const repoKey = args.repoSlug
    const records = readStore(repoKey)
    const id = String(records.length + 1)
    records.push({
      id,
      title: args.title,
      sourceBranch: args.sourceBranch,
      targetBranch: args.targetBranch ?? 'main',
      state: 'open',
      approvalCount: 1,
      comments: [],
    })
    writeStore(repoKey, records)
    return {
      kind: 'pull_request',
      pluginId: this.manifest.id,
      repoKey,
      externalId: id,
    }
  }

  async getPrStatus(ref: ExternalRef): Promise<ScmPrStatus> {
    const record = readStore(String(ref.repoKey ?? '')).find(r => r.id === ref.externalId)
    return {
      state: record?.state ?? 'open',
      approvalCount: record?.approvalCount ?? 0,
      commentCount: record?.comments.length ?? 0,
    }
  }

  async listPrComments(ref: ExternalRef): Promise<ScmPrComment[]> {
    const record = readStore(String(ref.repoKey ?? '')).find(r => r.id === ref.externalId)
    return record?.comments ?? []
  }

  async pollPr(ref: ExternalRef): Promise<ScmPollSnapshot> {
    const record = readStore(String(ref.repoKey ?? '')).find(r => r.id === ref.externalId)
    return {
      state: record?.state ?? 'open',
      approvalCount: record?.approvalCount ?? 0,
      commentCount: record?.comments.length ?? 0,
      comments: record?.comments ?? [],
    }
  }

  async mergePr(ref: ExternalRef): Promise<void> {
    const repoKey = String(ref.repoKey ?? '')
    const records = readStore(repoKey)
    const idx = records.findIndex(r => r.id === ref.externalId)
    if (idx >= 0) {
      records[idx] = { ...records[idx]!, state: 'merged' }
      writeStore(repoKey, records)
    }
  }

  normalizeInbound(): NormalizedEvent | null {
    return null
  }
}

export function createLocalScmPlugin(_args: { config: Record<string, unknown>; logger: Logger }): ScmPluginRuntime {
  return new LocalScmPlugin()
}

export { MANIFEST as LOCAL_SCM_MANIFEST }
