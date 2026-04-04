import { ToolContext } from './types'

// ── Coder account tools ───────────────────────────────────────────────────────

export async function bbCreateRepo(
  input: { repoSlug: string; description?: string },
  ctx: ToolContext,
): Promise<unknown> {
  const repo = await ctx.bbCoder.createRepo({
    repoSlug: input.repoSlug,
    description: input.description,
    isPrivate: true,
  })
  return { fullName: repo.full_name }
}

export async function bbCreatePr(
  input: {
    repoSlug: string
    title: string
    description?: string
    sourceBranch: string
    targetBranch?: string
    reviewerUsernames?: string[]
  },
  ctx: ToolContext,
): Promise<unknown> {
  const pr = await ctx.bbCoder.createPr({
    repoSlug: input.repoSlug,
    title: input.title,
    description: input.description,
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch ?? 'main',
    reviewerUsernames: input.reviewerUsernames ?? ctx.job.reviewers,
  })
  return { prId: pr.id, url: pr.links.html.href, state: pr.state }
}

export async function bbGetPrStatus(
  input: { repoSlug: string; prId: number },
  ctx: ToolContext,
): Promise<unknown> {
  return await ctx.bbCoder.getPrStatus(input.repoSlug, input.prId)
}

// ── Reviewer account tools ────────────────────────────────────────────────────

export async function bbGetPrComments(
  input: { repoSlug: string; prId: number },
  ctx: ToolContext,
): Promise<unknown> {
  const comments = await ctx.bbReviewer.getComments(input.repoSlug, input.prId)
  return comments.map(c => ({
    id: c.id,
    content: c.content.raw,
    parentId: c.parent?.id ?? null,
    createdOn: c.created_on,
    inline: c.inline ?? null,
  }))
}

export async function bbPostPrComment(
  input: { repoSlug: string; prId: number; content: string },
  ctx: ToolContext,
): Promise<unknown> {
  const comment = await ctx.bbReviewer.postComment(input.repoSlug, input.prId, input.content)
  return { commentId: comment.id }
}

export async function bbReplyToComment(
  input: { repoSlug: string; prId: number; parentId: number; content: string },
  ctx: ToolContext,
): Promise<unknown> {
  const comment = await ctx.bbReviewer.replyToComment(
    input.repoSlug, input.prId, input.parentId, input.content,
  )
  return { commentId: comment.id }
}

export async function bbApprovePr(
  input: { repoSlug: string; prId: number },
  ctx: ToolContext,
): Promise<unknown> {
  await ctx.bbReviewer.approvePr(input.repoSlug, input.prId)
  return { approved: true }
}

export async function bbMergePr(
  input: { repoSlug: string; prId: number; message?: string },
  ctx: ToolContext,
): Promise<unknown> {
  const pr = await ctx.bbReviewer.mergePr(input.repoSlug, input.prId, input.message)
  return { state: pr.state }
}
