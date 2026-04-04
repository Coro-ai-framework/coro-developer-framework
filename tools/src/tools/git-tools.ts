import { ToolContext } from './types'

export async function gitClone(
  input: { repoSlug: string; targetDir: string },
  ctx: ToolContext,
): Promise<unknown> {
  const dest = await ctx.gitClient.clone(input.repoSlug, input.targetDir)
  return { clonedTo: dest }
}

export async function gitCheckoutBranch(
  input: { repoDir: string; branch: string; create?: boolean },
  ctx: ToolContext,
): Promise<unknown> {
  await ctx.gitClient.checkoutBranch(input.repoDir, input.branch, input.create ?? false)
  return { branch: input.branch, created: input.create ?? false }
}

export async function gitCommit(
  input: { repoDir: string; message: string },
  ctx: ToolContext,
): Promise<unknown> {
  const commitHash = await ctx.gitClient.commitAll(input.repoDir, input.message)
  return { commitHash }
}

export async function gitPush(
  input: { repoDir: string; branch: string },
  ctx: ToolContext,
): Promise<unknown> {
  await ctx.gitClient.push(input.repoDir, input.branch)
  return { pushed: input.branch }
}

export async function gitDiff(
  input: { repoDir: string; base?: string },
  ctx: ToolContext,
): Promise<unknown> {
  const diff = await ctx.gitClient.getDiff(input.repoDir, input.base)
  return diff || '(no changes)'
}

export async function gitStatus(
  input: { repoDir: string },
  ctx: ToolContext,
): Promise<unknown> {
  return await ctx.gitClient.getStatus(input.repoDir)
}
