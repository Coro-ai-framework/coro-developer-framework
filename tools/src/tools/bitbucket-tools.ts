import { ToolContext, ToolResult } from './types'

// ── Coder account tools ───────────────────────────────────────────────────────
// Used by the coder agent to create repos, open PRs, and check PR state.

export async function bbCreateRepo(
  input: { repoSlug: string; description?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const repo = await ctx.bbCoder.createRepo({
      repoSlug: input.repoSlug,
      description: input.description,
      isPrivate: true,
    })
    return { success: true, output: { fullName: repo.full_name } }
  } catch (err) {
    return { success: false, error: String(err) }
  }
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
): Promise<ToolResult> {
  try {
    const pr = await ctx.bbCoder.createPr({
      repoSlug: input.repoSlug,
      title: input.title,
      description: input.description,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch ?? 'main',
      reviewerUsernames: input.reviewerUsernames ?? ctx.job.reviewers,
    })
    return {
      success: true,
      output: {
        prId: pr.id,
        url: pr.links.html.href,
        state: pr.state,
      },
    }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function bbGetPrStatus(
  input: { repoSlug: string; prId: number },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const status = await ctx.bbCoder.getPrStatus(input.repoSlug, input.prId)
    return { success: true, output: status }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

// ── Reviewer account tools ────────────────────────────────────────────────────
// Used by the pr-reviewer agent to read comments, post replies, approve, merge.

export async function bbGetPrComments(
  input: { repoSlug: string; prId: number },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const comments = await ctx.bbReviewer.getComments(input.repoSlug, input.prId)
    // Return only the fields Claude needs — omit large internal fields
    const summary = comments.map(c => ({
      id: c.id,
      content: c.content.raw,
      parentId: c.parent?.id ?? null,
      createdOn: c.created_on,
      inline: c.inline ?? null,
    }))
    return { success: true, output: summary }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function bbPostPrComment(
  input: { repoSlug: string; prId: number; content: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const comment = await ctx.bbReviewer.postComment(
      input.repoSlug,
      input.prId,
      input.content,
    )
    return { success: true, output: { commentId: comment.id } }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function bbReplyToComment(
  input: { repoSlug: string; prId: number; parentId: number; content: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const comment = await ctx.bbReviewer.replyToComment(
      input.repoSlug,
      input.prId,
      input.parentId,
      input.content,
    )
    return { success: true, output: { commentId: comment.id } }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function bbApprovePr(
  input: { repoSlug: string; prId: number },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    await ctx.bbReviewer.approvePr(input.repoSlug, input.prId)
    return { success: true, output: { approved: true } }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function bbMergePr(
  input: { repoSlug: string; prId: number; message?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const pr = await ctx.bbReviewer.mergePr(input.repoSlug, input.prId, input.message)
    return { success: true, output: { state: pr.state } }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
