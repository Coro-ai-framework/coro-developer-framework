import path from 'path'
import { simpleGit, SimpleGitOptions } from 'simple-git'
import { Settings } from '../config/settings'

// ── Git client ────────────────────────────────────────────────────────────────

/**
 * Wraps simple-git for all repository operations.
 *
 * Credentials are injected into clone URLs as `https://user:pass@host/...` and
 * are never written to disk. GIT_TERMINAL_PROMPT is disabled so git never
 * hangs waiting for interactive input.
 */
export class GitClient {
  constructor(
    private readonly workingDir: string,
    private readonly username: string,
    private readonly appPassword: string,
    private readonly workspace: string,
    private readonly host: string = 'bitbucket.org',
  ) {}

  /** Clone a repo into `targetDir` (relative to workingDir if not absolute). */
  async clone(repoSlug: string, targetDir: string): Promise<string> {
    const url = this.repoUrl(repoSlug)
    const dest = path.isAbsolute(targetDir) ? targetDir : path.join(this.workingDir, targetDir)
    await this.git(this.workingDir).clone(url, dest)
    return dest
  }

  /**
   * Pull latest from origin in the given repo directory.
   *
   * Handles branches without upstream tracking by explicitly passing
    * `origin <branch>`. This avoids spurious warnings on topic branches
   * that were checked out locally without `--track`.
   */
  async pull(repoDir: string): Promise<void> {
    const g = this.git(repoDir)
    const status = await g.status()
    if (status.tracking) {
      await g.pull()
      return
    }
    const branch = status.current
    if (!branch) {
      // Detached HEAD or empty repo — nothing to pull.
      return
    }
    await g.pull('origin', branch)
  }

  /** Checkout an existing branch, or create and checkout a new one. */
  async checkoutBranch(repoDir: string, branch: string, create = false): Promise<void> {
    if (create) {
      await this.git(repoDir).checkoutLocalBranch(branch)
    } else {
      await this.git(repoDir).checkout(branch)
    }
  }

  /** Stage all changes and create a commit. */
  async commitAll(repoDir: string, message: string): Promise<string> {
    const g = this.git(repoDir)
    await g.add('.')
    const result = await g.commit(message)
    return result.commit
  }

  /** Push a branch to origin, setting the upstream on first push. */
  async push(repoDir: string, branch: string): Promise<void> {
    await this.git(repoDir).push('origin', branch, ['--set-upstream'])
  }

  /** Push a branch to a specific remote. */
  async pushToRemote(repoDir: string, remote: string, branch: string): Promise<void> {
    await this.git(repoDir).push(remote, branch, ['--set-upstream'])
  }

  /**
   * Get the diff of working tree changes, or between two refs.
   * @param base  If provided, diffs `base..HEAD`. Otherwise diffs unstaged changes.
   */
  async getDiff(repoDir: string, base?: string): Promise<string> {
    if (base) {
      return this.git(repoDir).diff([base, 'HEAD'])
    }
    return this.git(repoDir).diff()
  }

  /** Get the last N commit one-liners. */
  async getLog(repoDir: string, maxCount = 10): Promise<string[]> {
    const result = await this.git(repoDir).log({ maxCount })
    return result.all.map(c => `${c.hash.slice(0, 8)} ${c.date.slice(0, 10)} ${c.message}`)
  }

  /** Get a human-readable working tree status. */
  async getStatus(repoDir: string): Promise<string> {
    const result = await this.git(repoDir).status()
    if (result.files.length === 0) return 'nothing to commit, working tree clean'
    return result.files
      .map(f => `${f.index !== ' ' ? f.index : f.working_dir} ${f.path}`)
      .join('\n')
  }

  /** List all local branch names. */
  async listBranches(repoDir: string): Promise<string[]> {
    const result = await this.git(repoDir).branchLocal()
    return result.all
  }

  /** Get the name of the currently checked-out branch. */
  async currentBranch(repoDir: string): Promise<string> {
    const result = await this.git(repoDir).branchLocal()
    return result.current
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private repoUrl(repoSlug: string): string {
    const u = encodeURIComponent(this.username)
    const p = encodeURIComponent(this.appPassword)
    return `https://${u}:${p}@${this.host}/${this.workspace}/${repoSlug}.git`
  }

  private git(dir: string) {
    return simpleGit({ baseDir: dir, ...gitEnv() }).env(GIT_SPAWN_ENV)
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createGitClient(settings: Settings): GitClient {
  const { coderAccount } = settings.bitbucket
  // Bitbucket has three token types and each needs a different git
  // HTTPS username:
  //   - Legacy App Passwords     -> your Atlassian account email
  //   - Legacy Access Tokens     -> 'x-token-auth' (random prefix)
  //   - New API tokens (ATATT…) -> 'x-bitbucket-api-token-auth'
  // Old code mapped the ATATT prefix to 'x-token-auth' which is the
  // wrong scheme and produces a 401 the agent then mis-classifies as
  // "missing repo scope".
  const gitUsername = coderAccount.appPassword.startsWith('ATATT')
    ? 'x-bitbucket-api-token-auth'
    : coderAccount.username

  return new GitClient(
    settings.paths.workingDir,
    gitUsername,
    coderAccount.appPassword,
    settings.bitbucket.workspace,
    'bitbucket.org',
  )
}

/** Create a GitClient that clones from GitHub using a PAT. */
export function createGitHubGitClient(settings: Settings): GitClient | null {
  if (!settings.github.token) return null
  // GitHub PATs use x-access-token as the username for HTTPS auth
  return new GitClient(
    settings.paths.workingDir,
    'x-access-token',
    settings.github.token,
    settings.github.owner,
    'github.com',
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Disable interactive prompts so git never hangs in a subprocess. */
function gitEnv(): Partial<SimpleGitOptions> {
  return {
    config: ['core.askpass='],
    trimmed: false,
  }
}

/** Injected into every simple-git spawn so git never prompts for credentials. */
const GIT_SPAWN_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' }
