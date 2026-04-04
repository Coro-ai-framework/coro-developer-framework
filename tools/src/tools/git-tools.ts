import { ToolContext, ToolResult } from './types'

// ── Tools ─────────────────────────────────────────────────────────────────────

export async function gitClone(
  input: { repoSlug: string; targetDir: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const dest = await ctx.gitClient.clone(input.repoSlug, input.targetDir)
    return { success: true, output: { clonedTo: dest } }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function gitCheckoutBranch(
  input: { repoDir: string; branch: string; create?: boolean },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    await ctx.gitClient.checkoutBranch(input.repoDir, input.branch, input.create ?? false)
    return { success: true, output: { branch: input.branch, created: input.create ?? false } }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function gitCommit(
  input: { repoDir: string; message: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const commitHash = await ctx.gitClient.commitAll(input.repoDir, input.message)
    return { success: true, output: { commitHash } }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function gitPush(
  input: { repoDir: string; branch: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    await ctx.gitClient.push(input.repoDir, input.branch)
    return { success: true, output: { pushed: input.branch } }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function gitDiff(
  input: { repoDir: string; base?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const diff = await ctx.gitClient.getDiff(input.repoDir, input.base)
    return { success: true, output: diff || '(no changes)' }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function gitStatus(
  input: { repoDir: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const status = await ctx.gitClient.getStatus(input.repoDir)
    return { success: true, output: status }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
