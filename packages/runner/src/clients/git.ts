import { simpleGit, SimpleGitOptions } from 'simple-git'

// ── Git client ────────────────────────────────────────────────────────────────

/**
 * Wraps simple-git for operations on checkouts that already exist — today,
 * only the intelligence directory (`jobs/runner.ts` pulls it, the hybrid
 * dispatcher commits and pushes proposals through it).
 *
 * It holds no credentials. It used to carry a username/token and splice them
 * into a clone URL, which is the pattern `clients/git-auth.ts` exists to
 * replace: a token in a remote authenticates as whoever owned it at clone
 * time, not as whoever Settings names now. Job checkouts go through
 * `scm_clone_repo`, which persists a clean URL and installs the `coro
 * git-credential` helper; these operations inherit whatever auth their
 * checkout was configured with.
 *
 * GIT_TERMINAL_PROMPT is disabled so git never hangs waiting for input.
 */
export class GitClient {
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

  private git(dir: string) {
    return simpleGit({
      baseDir: dir,
      ...gitEnv(),
      // simple-git ≥3.36 treats GIT_ASKPASS / core.askpass as unsafe.
      // We only clear them so a missing credential fails fast.
      unsafe: { allowUnsafeProtocolOverride: false, allowUnsafeAskPass: true },
    }).env(GIT_SPAWN_ENV)
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createGitClient(): GitClient {
  return new GitClient()
}

// This factory takes no credentials, and there is deliberately no
// provider-specific variant of it. Identity for git belongs to the SCM plugin
// and the `coro git-credential` helper, which resolve it from the repository
// being written to — the contribution fork and its upstream answer as the
// contribution account, everything else as the plugin's. A client that fixed a
// token at construction time could not express that, and a GitHub one would
// have pushed to the fork as the wrong account.

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
