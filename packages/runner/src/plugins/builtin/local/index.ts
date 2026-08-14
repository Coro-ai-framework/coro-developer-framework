// ── Local filesystem SCM plugin ───────────────────────────────────────────────
//
// Lets someone run a real job before they have connected any account: the
// "repo" is a git checkout already on their disk, and the deliverable is a
// branch pushed into it.
//
// There is no server to hold review state, so the PR lifecycle (status,
// comments, approval, merge) is simulated in a JSON record under
// `~/.coro/local-scm/`. That record is bookkeeping for the agents — the real
// output is the branch, which the user reviews and merges with their own
// tools. `mergePr` deliberately does not touch their working tree.

import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Logger } from 'pino'
import type { ExternalRef, NormalizedEvent } from '@coro-ai/cloud-protocol'
import type {
  PluginDeps,
  PluginHealth,
  PluginManifest,
  PluginTestResult,
  ScmCloneInfo,
  ScmCreatePrArgs,
  ScmPluginRuntime,
  ScmPollSnapshot,
  ScmPrComment,
  ScmPrStatus,
} from '../../types'

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 30_000

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
  intelligence: {
    snippets: [
      { id: 'local-delivery', relativePath: 'snippets/local-delivery.md' },
    ],
  },
  ui: {
    subtitle: 'Work on local repositories — no account needed.',
    recommendedForOnboarding: true,
    // Jobs name a filesystem path here, not an `owner/repo` slug. The Create
    // Job form reads this to label and validate the field correctly without
    // the dashboard having to know this plugin exists.
    repoRef: {
      kind: 'path',
      label: 'Repository path',
      hint: 'Absolute path to a git checkout on this machine.',
      placeholder: '/Users/you/code/my-service',
    },
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

const STORE_ROOT = path.join(os.homedir(), '.coro', 'local-scm')

function storePath(repoKey: string): string {
  const slug = repoKey.replace(/[^\w.-]+/g, '_')
  const file = path.join(STORE_ROOT, `${slug}.json`)
  // The slug is derived from a repo path, so a pathological key must not be
  // able to steer the write outside the store.
  const resolved = path.resolve(file)
  if (path.dirname(resolved) !== path.resolve(STORE_ROOT)) {
    throw new Error(`local scm: refusing to use store path outside ${STORE_ROOT}`)
  }
  return resolved
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
    throw new Error(
      `local scm: repo path must be absolute: "${repoPath}". ` +
      'In local mode the repository is a path on this machine, not an owner/repo slug.',
    )
  }
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    throw new Error(`local scm: not a git repository: ${repoPath}`)
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Mutate a stored record in place. Throws when the PR is unknown — the agents
 * treat a missing PR as a bug worth surfacing, not as a no-op.
 */
function updateRecord(
  ref: ExternalRef,
  mutate: (record: LocalPrRecord) => void,
): LocalPrRecord {
  const repoKey = String(ref.repoKey ?? '')
  const records = readStore(repoKey)
  const idx = records.findIndex(r => r.id === ref.externalId)
  if (idx < 0) {
    throw new Error(`local scm: no local pull request ${ref.externalId} for ${repoKey}`)
  }
  const record = records[idx]!
  mutate(record)
  records[idx] = record
  writeStore(repoKey, records)
  return record
}

class LocalScmPlugin implements ScmPluginRuntime {
  readonly manifest = MANIFEST
  readonly kind = 'scm' as const

  private logger?: Logger

  async init(_config: Record<string, unknown>, deps: PluginDeps): Promise<void> {
    this.logger = deps.logger
  }

  async healthcheck(): Promise<PluginHealth> {
    return { ok: true }
  }

  async testConnection(): Promise<PluginTestResult> {
    return {
      ok: true,
      message: 'Local mode ready — point a job at a repository path on this machine.',
    }
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
    // Validate before writing: an unvalidated key would create an orphan JSON
    // record for a repository that does not exist, and the job would look
    // like it succeeded.
    assertGitRepo(repoKey)

    await this.publishBranch(args)

    const records = readStore(repoKey)
    const id = String(records.length + 1)
    records.push({
      id,
      title: args.title,
      sourceBranch: args.sourceBranch,
      targetBranch: args.targetBranch ?? 'main',
      state: 'open',
      approvalCount: 0,
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

  /**
   * Push the job's branch into the user's repository.
   *
   * This is the whole point of the local provider: without it the work stays
   * in a throwaway clone under the working directory and the user never sees
   * it. Pushing a *new* branch into a non-bare repo is safe; pushing the
   * branch that repo currently has checked out is not, and git refuses it —
   * which is why the agent's `coro/*` branch is the only thing sent.
   */
  private async publishBranch(args: ScmCreatePrArgs): Promise<void> {
    const checkout = args.sourceCheckoutDir
    if (!checkout) {
      throw new Error(
        `local scm: cannot deliver branch "${args.sourceBranch}" — no job checkout is known. ` +
        'Clone the repository with `scm_clone_repo` before opening a pull request.',
      )
    }
    if (!fs.existsSync(path.join(checkout, '.git'))) {
      throw new Error(`local scm: job checkout is not a git repository: ${checkout}`)
    }
    try {
      await execFileAsync(
        'git',
        ['-C', checkout, 'push', 'origin', `${args.sourceBranch}:refs/heads/${args.sourceBranch}`],
        { timeout: GIT_TIMEOUT_MS, encoding: 'utf-8' },
      )
      this.logger?.info(
        { repo: args.repoSlug, branch: args.sourceBranch },
        'local scm: pushed branch into the target repository',
      )
    } catch (err) {
      const detail = (err as { stderr?: string })?.stderr?.trim()
        || (err instanceof Error ? err.message : String(err))
      throw new Error(
        `local scm: failed to push branch "${args.sourceBranch}" into ${args.repoSlug}: ${detail}`,
      )
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

  /**
   * Record a review comment.
   *
   * Implemented rather than omitted because the generic `scm_post_pr_comment`
   * tool answers an unimplemented op with an error claiming the plugin has an
   * MCP server and a missing tool mapping — untrue here and unactionable. The
   * code-reviewer and pr-reviewer agents both call this on every job.
   */
  async postPrComment(ref: ExternalRef, body: string): Promise<ScmPrComment> {
    let created!: ScmPrComment
    updateRecord(ref, record => {
      created = {
        id: String(record.comments.length + 1),
        body,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        author: 'coro',
      }
      record.comments.push(created)
    })
    return created
  }

  async replyToComment(ref: ExternalRef, parentId: string, body: string): Promise<ScmPrComment> {
    let created!: ScmPrComment
    updateRecord(ref, record => {
      if (!record.comments.some(c => c.id === parentId)) {
        throw new Error(`local scm: no comment ${parentId} on pull request ${ref.externalId}`)
      }
      created = {
        id: String(record.comments.length + 1),
        body,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        parentId,
        author: 'coro',
      }
      record.comments.push(created)
    })
    return created
  }

  async approvePr(ref: ExternalRef): Promise<void> {
    updateRecord(ref, record => {
      record.approvalCount += 1
    })
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

  /**
   * Mark the simulated PR merged.
   *
   * Intentionally does not merge anything in the user's repository: Coro must
   * not rewrite a branch someone may have checked out, and the local flow's
   * contract is that the human does the merge.
   */
  async mergePr(ref: ExternalRef): Promise<void> {
    updateRecord(ref, record => {
      record.state = 'merged'
    })
  }

  intelligenceRoot(): string {
    return path.join(__dirname, 'intelligence')
  }

  normalizeInbound(): NormalizedEvent | null {
    return null
  }
}

export function createLocalScmPlugin(_args: { config: Record<string, unknown>; logger: Logger }): ScmPluginRuntime {
  return new LocalScmPlugin()
}

export { MANIFEST as LOCAL_SCM_MANIFEST }
