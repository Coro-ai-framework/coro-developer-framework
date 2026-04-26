import { ToolContext, PhaseSignals } from './tools/types'
import { Artifact, WorkItem, Insight, Job } from './jobs/types'

// ── Response helpers (shared with MCP server wiring) ──────────────────────────

export function mcpText(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

export function mcpError(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], isError: true as const }
}

/**
 * All Coro MCP tool implementations. Used by `createCoroMcpServer` and by tests
 * that invoke handlers with a mock {@link ToolContext}.
 */
export function createMcpToolHandlers(ctx: ToolContext, signals: PhaseSignals) {
  const text = mcpText
  const error = mcpError

  const setWorkItems = async ({ workItems }: { workItems: string[] }) => {
    const items: WorkItem[] = workItems.map(name => ({
      name, status: 'pending', loopCount: 0,
    }))
    await ctx.stateBackend.updateJob(ctx.job.id, { workItems: items })
    ctx.job = await ctx.stateBackend.getJob(ctx.job.id) as Job
    return text({ registered: workItems.length })
  }

  const updateWorkItem = async ({ name, status, incrementLoop }: {
    name: string; status?: string; incrementLoop?: boolean
  }) => {
    const job = await ctx.stateBackend.getJob(ctx.job.id) as Job
    const workItems = job.workItems.map(item => {
      if (item.name !== name) return item
      return {
        ...item,
        ...(status ? { status: status as WorkItem['status'] } : {}),
        loopCount: incrementLoop ? item.loopCount + 1 : item.loopCount,
      }
    })
    const current = workItems.find(item => item.name === name)
    await ctx.stateBackend.updateJob(ctx.job.id, {
      workItems,
      currentWorkItem: status === 'in-progress' ? name : ctx.job.currentWorkItem,
      workItemLoopCount: current?.loopCount ?? ctx.job.workItemLoopCount,
    })
    ctx.job = await ctx.stateBackend.getJob(ctx.job.id) as Job
    return text({ updated: name, status: current?.status, loopCount: current?.loopCount })
  }

  const getWorkItems = async () => {
    const job = await ctx.stateBackend.getJob(ctx.job.id) as Job
    ctx.job = job
    return text({ workItems: job.workItems, currentWorkItem: job.currentWorkItem })
  }

  return {
    // BitBucket — coder
    bb_create_repo: async ({ repoSlug, description }: { repoSlug: string; description?: string }) => {
      const repo = await ctx.bbCoder.createRepo({ repoSlug, description, isPrivate: true })
      return text({ fullName: repo.full_name })
    },

    bb_create_pr: async ({
      repoSlug, title, description, sourceBranch, targetBranch, reviewerUsernames,
    }: {
      repoSlug: string
      title: string
      description?: string
      sourceBranch: string
      targetBranch?: string
      reviewerUsernames?: string[]
    }) => {
      const { jobReviewers } = await import('./jobs/types')
      const pr = await ctx.bbCoder.createPr({
        repoSlug, title, description,
        sourceBranch,
        targetBranch: targetBranch ?? 'main',
        reviewerUsernames: reviewerUsernames ?? jobReviewers(ctx.job),
      })

      await ctx.stateBackend.addPrMapping(ctx.job.id, {
        prId: pr.id,
        workItem: ctx.job.currentWorkItem ?? ctx.job.phase,
        repoSlug: repoSlug,
        openedAt: new Date().toISOString(),
      })

      return text({ prId: pr.id, url: pr.links.html.href, state: pr.state })
    },

    bb_get_pr_status: async ({ repoSlug, prId }: { repoSlug: string; prId: number }) => {
      const status = await ctx.bbCoder.getPrStatus(repoSlug, prId)
      return text(status)
    },

    // BitBucket — reviewer
    bb_get_pr_comments: async ({ repoSlug, prId }: { repoSlug: string; prId: number }) => {
      const comments = await ctx.bbReviewer.getComments(repoSlug, prId)
      const mapped = comments.map(c => ({
        id: c.id,
        content: c.content.raw,
        parentId: c.parent?.id ?? null,
        createdOn: c.created_on,
        inline: c.inline ?? null,
      }))
      return text(mapped)
    },

    bb_post_pr_comment: async ({ repoSlug, prId, content }: { repoSlug: string; prId: number; content: string }) => {
      const comment = await ctx.bbReviewer.postComment(repoSlug, prId, content)
      return text({ commentId: comment.id })
    },

    bb_reply_to_comment: async ({
      repoSlug, prId, parentId, content,
    }: { repoSlug: string; prId: number; parentId: number; content: string }) => {
      const comment = await ctx.bbReviewer.replyToComment(repoSlug, prId, parentId, content)
      return text({ commentId: comment.id })
    },

    bb_approve_pr: async ({ repoSlug, prId }: { repoSlug: string; prId: number }) => {
      await ctx.bbReviewer.approvePr(repoSlug, prId)
      return text({ approved: true })
    },

    bb_merge_pr: async ({ repoSlug, prId, message }: { repoSlug: string; prId: number; message?: string }) => {
      const pr = await ctx.bbReviewer.mergePr(repoSlug, prId, message)
      return text({ state: pr.state })
    },

    // GitHub — uses a single token for both coder and reviewer operations
    gh_create_repo: async ({ repoSlug, description }: { repoSlug: string; description?: string }) => {
      if (!ctx.ghClient) return error('GitHub is not configured. Set GITHUB_TOKEN and GITHUB_OWNER.')
      const repo = await ctx.ghClient.createRepo({ repoSlug, description, isPrivate: true })
      return text({ fullName: repo.full_name })
    },

    gh_create_pr: async ({
      repoSlug, title, description, sourceBranch, targetBranch, reviewerUsernames,
    }: {
      repoSlug: string
      title: string
      description?: string
      sourceBranch: string
      targetBranch?: string
      reviewerUsernames?: string[]
    }) => {
      if (!ctx.ghClient) return error('GitHub is not configured. Set GITHUB_TOKEN and GITHUB_OWNER.')
      const { jobReviewers } = await import('./jobs/types')
      const pr = await ctx.ghClient.createPr({
        repoSlug, title, description,
        sourceBranch,
        targetBranch: targetBranch ?? 'main',
        reviewerUsernames: reviewerUsernames ?? jobReviewers(ctx.job),
      })

      await ctx.stateBackend.addPrMapping(ctx.job.id, {
        prId: pr.id,
        workItem: ctx.job.currentWorkItem ?? ctx.job.phase,
        repoSlug: repoSlug,
        openedAt: new Date().toISOString(),
      })

      return text({ prId: pr.id, url: pr.links.html.href, state: pr.state })
    },

    gh_get_pr_status: async ({ repoSlug, prId }: { repoSlug: string; prId: number }) => {
      if (!ctx.ghClient) return error('GitHub is not configured.')
      const status = await ctx.ghClient.getPrStatus(repoSlug, prId)
      return text(status)
    },

    gh_get_pr_comments: async ({ repoSlug, prId }: { repoSlug: string; prId: number }) => {
      if (!ctx.ghClient) return error('GitHub is not configured.')
      const comments = await ctx.ghClient.getComments(repoSlug, prId)
      const mapped = comments.map(c => ({
        id: c.id,
        content: c.content.raw,
        parentId: c.parent?.id ?? null,
        createdOn: c.created_on,
        inline: c.inline ?? null,
      }))
      return text(mapped)
    },

    gh_post_pr_comment: async ({ repoSlug, prId, content }: { repoSlug: string; prId: number; content: string }) => {
      if (!ctx.ghClient) return error('GitHub is not configured.')
      const comment = await ctx.ghClient.postComment(repoSlug, prId, content)
      return text({ commentId: comment.id })
    },

    gh_reply_to_comment: async ({
      repoSlug, prId, parentId, content,
    }: { repoSlug: string; prId: number; parentId: number; content: string }) => {
      if (!ctx.ghClient) return error('GitHub is not configured.')
      const comment = await ctx.ghClient.replyToComment(repoSlug, prId, parentId, content)
      return text({ commentId: comment.id })
    },

    gh_approve_pr: async ({ repoSlug, prId }: { repoSlug: string; prId: number }) => {
      if (!ctx.ghClient) return error('GitHub is not configured.')
      await ctx.ghClient.approvePr(repoSlug, prId)
      return text({ approved: true })
    },

    gh_merge_pr: async ({ repoSlug, prId, message }: { repoSlug: string; prId: number; message?: string }) => {
      if (!ctx.ghClient) return error('GitHub is not configured.')
      const pr = await ctx.ghClient.mergePr(repoSlug, prId, message)
      return text({ state: pr.state })
    },

    // Test harness
    run_go_build: async ({ repoDir }: { repoDir: string }) => {
      const { exec: execCb } = await import('child_process')
      const { promisify } = await import('util')
      const execAsync = promisify(execCb)
      try {
        const { stdout, stderr } = await execAsync('go build ./...', {
          cwd: repoDir, timeout: 120_000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        })
        return text({ stdout: stdout.trim(), stderr: stderr.trim() })
      } catch (err: unknown) {
        const e = err as { stderr?: string; message?: string }
        return error(e.stderr ?? e.message ?? String(err))
      }
    },

    start_go_service: async ({
      label, repoDir, binaryName, port, env: extraEnv,
    }: {
      label: string
      repoDir: string
      binaryName: string
      port: number
      env?: Record<string, string>
    }) => {
      if (ctx.runningServices.has(label)) return error(`Service "${label}" is already running`)
      const { spawn } = await import('child_process')
      const child = spawn(`./${binaryName}`, [], {
        cwd: repoDir,
        env: { ...process.env, PORT: String(port), ...extraEnv },
        stdio: 'ignore', detached: false,
      })
      ctx.runningServices.set(label, child)
      child.on('exit', () => { ctx.runningServices.delete(label) })
      await new Promise(r => setTimeout(r, 1500))
      return text({ label, port, pid: child.pid })
    },

    stop_go_service: async ({ label }: { label: string }) => {
      const child = ctx.runningServices.get(label)
      if (!child) return error(`No running service with label "${label}"`)
      child.kill('SIGTERM')
      ctx.runningServices.delete(label)
      return text({ stopped: label })
    },

    compare_request: async ({
      goBaseUrl, dotnetBaseUrl, method, path: reqPath, headers, body,
    }: {
      goBaseUrl: string
      dotnetBaseUrl: string
      method: string
      path: string
      headers?: Record<string, string>
      body?: string
    }) => {
      const doReq = async (base: string) => {
        const res = await fetch(`${base}${reqPath}`, {
          method, body: body ?? undefined,
          headers: { 'Content-Type': 'application/json', ...headers },
          signal: AbortSignal.timeout(15_000),
        })
        return { status: res.status, body: await res.text() }
      }
      const [goRes, dotnetRes] = await Promise.all([doReq(goBaseUrl), doReq(dotnetBaseUrl)])
      const norm = (s: string) => { try { return JSON.stringify(JSON.parse(s)) } catch { return s.trim() } }
      return text({
        match: goRes.status === dotnetRes.status && norm(goRes.body) === norm(dotnetRes.body),
        go: goRes, dotnet: dotnetRes,
      })
    },

    // Observability
    loki_query: async ({
      logQL, start, end, limit,
    }: { logQL: string; start: string; end?: string; limit?: number }) => {
      const result = await ctx.lokiClient.query(logQL, start, end ?? 'now', limit ?? 500)
      return text(result)
    },

    tempo_get_trace: async ({ traceId }: { traceId: string }) => {
      const result = await ctx.tempoClient.getTrace(traceId)
      return text(result)
    },

    tempo_search: async ({
      query: q, start, end, limit,
    }: { query: string; start: string; end?: string; limit?: number }) => {
      const result = await ctx.tempoClient.search(q, start, end, limit ?? 20)
      return text(result)
    },

    // Jira
    jira_get_issue: async ({ ticketId }: { ticketId: string }) => {
      const result = await ctx.jiraClient.getIssue(ticketId)
      return text(result)
    },

    jira_post_comment: async ({ ticketId, body }: { ticketId: string; body: string }) => {
      const result = await ctx.jiraClient.postComment(ticketId, body)
      return text(result)
    },

    jira_transition_issue: async ({ ticketId, transitionId }: { ticketId: string; transitionId: string }) => {
      const result = await ctx.jiraClient.transitionIssue(ticketId, transitionId)
      return text(result ?? { transitioned: true })
    },

    // Work-item tracking — pure state CRUD, zero orchestration logic
    set_work_items: setWorkItems,
    update_work_item: updateWorkItem,
    get_work_items: getWorkItems,

    request_new_session: async ({ reason }: { reason: string }) => {
      await ctx.stateBackend.updateJob(ctx.job.id, { sessionId: undefined })
      ctx.job = await ctx.stateBackend.getJob(ctx.job.id) as Job
      await ctx.stateBackend.appendLog(ctx.job.id, `[session-reset] ${reason}`)
      return text({ newSession: true, reason })
    },

    set_job_params: async ({ params }: { params: Record<string, unknown> }) => {
      const job = await ctx.stateBackend.getJob(ctx.job.id) as Job
      const merged = { ...job.params, ...params }
      await ctx.stateBackend.updateJob(ctx.job.id, { params: merged })
      ctx.job = await ctx.stateBackend.getJob(ctx.job.id) as Job
      return text({ updated: Object.keys(params) })
    },

    // Job control
    goto_phase: async ({ phase }: { phase: string }) => {
      signals.nextPhase = phase
      return text({ goingToPhase: phase })
    },

    await_event: async ({ eventName, prId }: { eventName: string; prId?: number }) => {
      signals.awaitingEvent = eventName
      signals.awaitingPrId = prId
      return text({ awaiting: eventName, prId: prId ?? null })
    },

    escalate: async ({ reason }: { reason: string }) => {
      const { STATUS_ESCALATED } = await import('./jobs/types')
      await ctx.stateBackend.updateJob(ctx.job.id, {
        status: STATUS_ESCALATED,
        escalationMessage: reason,
      })
      signals.escalated = true
      signals.escalationReason = reason
      ctx.logger.warn({ jobId: ctx.job.id, reason }, 'Job escalated')
      return text({ escalated: true, reason })
    },

    add_insight: async ({ category, summary, detail, suggestion }: {
      category: string; summary: string; detail: string; suggestion?: string
    }) => {
      const job = await ctx.stateBackend.getJob(ctx.job.id) as Job
      const insight: Insight = {
        phase: job.phase,
        category,
        summary,
        detail,
        ...(suggestion ? { suggestion } : {}),
      }
      const insights = [...(job.insights ?? []), insight]
      await ctx.stateBackend.updateJob(ctx.job.id, { insights })
      ctx.job = await ctx.stateBackend.getJob(ctx.job.id) as Job
      await ctx.stateBackend.appendLog(ctx.job.id, `[insight] ${category}: ${summary}`)
      return text({ recorded: true, totalInsights: insights.length })
    },

    log: async ({ message }: { message: string }) => {
      await ctx.stateBackend.appendLog(ctx.job.id, message)
      return text(null)
    },

    // Artefacts — generic per-phase outputs that the dashboard knows how to render
    post_artifact: async ({ phase, kind, title, data }: {
      phase?: string; kind: string; title: string; data?: Record<string, unknown>
    }) => {
      const job = await ctx.stateBackend.getJob(ctx.job.id) as Job
      const now = new Date()
      const rand = Math.random().toString(36).slice(2, 8)
      const artifact: Artifact = {
        id: `art-${now.getTime()}-${rand}`,
        phase: phase ?? job.phase,
        kind,
        title,
        data: data ?? {},
        createdBy: job.currentWorkItem ? `${job.phase}:${job.currentWorkItem}` : job.phase,
        createdAt: now.toISOString(),
      }
      const artifacts = [...(job.artifacts ?? []), artifact]
      await ctx.stateBackend.updateJob(ctx.job.id, { artifacts })
      ctx.job = await ctx.stateBackend.getJob(ctx.job.id) as Job
      await ctx.stateBackend.appendLog(ctx.job.id, `[artifact] ${artifact.phase}/${kind}: ${title}`)
      return text({ id: artifact.id, phase: artifact.phase, kind, title })
    },

    get_artifacts: async ({ phase }: { phase?: string }) => {
      const job = await ctx.stateBackend.getJob(ctx.job.id) as Job
      const all = job.artifacts ?? []
      const filtered = phase ? all.filter(a => a.phase === phase) : all
      return text({ artifacts: filtered, total: filtered.length })
    },

    // Self-improvement
    propose_change: async (args: {
      type:
        | 'new-tool' | 'modify-tool' | 'new-workflow' | 'modify-workflow'
        | 'new-agent' | 'modify-agent' | 'memory-update' | 'source-change'
        | 'skill-create' | 'skill-update' | 'claude-md-update'
      title: string
      rationale: string
      description: string
      files?: Array<{ path: string; content: string }>
      targetFile?: string
      proposedContent?: string
    }) => {
      const { proposeChange } = await import('./tools/self-improvement')
      const result = await proposeChange({
        type: args.type,
        title: args.title,
        rationale: args.rationale,
        description: args.description,
        files: args.files,
        targetFile: args.targetFile,
        proposedContent: args.proposedContent,
      }, ctx)
      return text(result)
    },

    list_proposals: async (args: { limit?: number; type?: string }) => {
      const { listProposals } = await import('./tools/self-improvement')
      const result = await listProposals({ limit: args.limit, type: args.type }, ctx)
      return text(result)
    },

    // On-demand memory access. The system prompt no longer carries the memory
    // bundle — agents pull what they need via this tool. Zero args returns the
    // index + every file linked from it + any pending on-disk proposals; pass
    // a specific relative path (e.g. "known-pitfalls.md") to fetch a single
    // file without the rest.
    read_memory: async (args: { file?: string }) => {
      const fs = await import('fs/promises')
      const nodePath = await import('path')
      const memoryDir = nodePath.join(ctx.settings.paths.coroIntelligenceDir, 'memory')

      const readFile = async (rel: string): Promise<string | null> => {
        try {
          return await fs.readFile(nodePath.join(memoryDir, rel), 'utf-8')
        } catch {
          return null
        }
      }

      if (args.file) {
        const content = await readFile(args.file)
        if (content === null) return error(`memory file not found: ${args.file}`)
        return text({ file: args.file, content })
      }

      const index = await readFile('MEMORY.md')
      if (index === null) {
        return text({ index: null, files: [], proposals: [] })
      }

      const linkRe = /\[[^\]]*\]\(([^)]+)\)/g
      const linkedFiles: Array<{ path: string; content: string }> = []
      const seen = new Set<string>()
      let match: RegExpExecArray | null
      while ((match = linkRe.exec(index)) !== null) {
        const href = match[1].split(/[?#]/)[0]
        if (!href || href.startsWith('http') || href.startsWith('#') || seen.has(href)) continue
        seen.add(href)
        const c = await readFile(href)
        if (c !== null) linkedFiles.push({ path: href, content: c })
      }

      const proposals: Array<{ path: string; content: string }> = []
      try {
        const entries = await fs.readdir(nodePath.join(memoryDir, 'proposals'))
        for (const f of entries.filter(e => e.endsWith('.md')).sort()) {
          const c = await readFile(`proposals/${f}`)
          if (c !== null) proposals.push({ path: `proposals/${f}`, content: c })
        }
      } catch {
        // proposals dir absent — normal for new installs
      }

      return text({ index, files: linkedFiles, proposals })
    },
  }
}

export type McpToolHandlers = ReturnType<typeof createMcpToolHandlers>
