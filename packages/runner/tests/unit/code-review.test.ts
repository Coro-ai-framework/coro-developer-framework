import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JobType, type Job } from '@coro-ai/cloud-protocol'
import { buildPhaseSnapshot, sessionCostBaseline } from '../../src/jobs/phase-observability'
import { CODE_REVIEW_KIND, codeReviewLenses, type CodeReviewData } from '../../src/tools/code-review'
import type { ToolContext } from '../../src/tools/types'
import type { LensConfig } from '../../src/workflow-parser'

const LENSES: LensConfig[] = [
  { name: 'correctness', when: ['code'], tools: ['Read'] },
  { name: 'tests', when: ['code', 'tests'], tools: ['Read'] },
  { name: 'security', when: ['code', 'deps', 'infra', 'auth'], tools: ['Read'] },
  { name: 'verifier', when: ['always'], tools: ['Read'] },
]

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  })
}

function reply(findings: unknown[]): { output: string; usage: Record<string, number> } {
  return {
    output: '```json\n' + JSON.stringify({ findings, notes: '', sourcesUsed: [] }) + '\n```',
    usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalCostUsd: 0.5 },
  }
}

const bug = { severity: 'major', category: 'correctness', path: 'src/a.ts', line: 2, title: 'Off by one', body: 'The loop skips the last item.' }

describe('code_review_lenses', () => {
  let root: string
  let job: Job
  let runSubagent: ReturnType<typeof vi.fn>
  let recordUsage: ReturnType<typeof vi.fn>

  function makeCtx(overrides: { job?: Partial<Job>; codeReview?: { lenses: boolean }; executor?: object; lenses?: LensConfig[] } = {}): ToolContext {
    job = {
      id: 'job-1',
      type: JobType.Job,
      phase: 'coding',
      currentWorkItem: 'add-cache',
      artifacts: [],
      params: { repoSlug: 'svc' },
      ...overrides.job,
    } as unknown as Job
    const ctx = {
      job,
      settings: {
        paths: { workingDir: root },
        llm: { aliases: {} },
        ...(overrides.codeReview ? { codeReview: overrides.codeReview } : {}),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      plugins: {},
      stateBackend: {
        getJob: async () => job,
        updateJob: async (_id: string, patch: Partial<Job>) => { job = { ...job, ...patch } },
      },
      currentPhase: {
        phaseConf: { name: 'coding', lenses: overrides.lenses ?? LENSES },
        executor: overrides.executor ?? { manifest: { id: 'stub' }, capabilities: {}, runSubagent },
        workingDir: path.join(root, 'job-1'),
        jobIntelligenceDir: path.join(root, 'intel'),
        hookPolicy: {},
        mcpServer: { kind: 'sdk-instance', id: 'coro', instance: {} },
        pluginMcpServers: {},
        recordUsage,
      },
    } as unknown as ToolContext
    return ctx
  }

  const artifactData = (): CodeReviewData =>
    job.artifacts!.find(item => item.kind === CODE_REVIEW_KIND)!.data as unknown as CodeReviewData

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'coro-code-review-'))
    const repo = path.join(root, 'job-1', 'svc')
    mkdirSync(path.join(repo, 'src'), { recursive: true })
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 1\n')
    writeFileSync(path.join(repo, 'README.md'), '# svc\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'base')
    git(repo, 'checkout', '-q', '-b', 'feature')
    writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2\nexport const b = 3\n')
    runSubagent = vi.fn(async () => reply([bug]))
    recordUsage = vi.fn()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses pr-review jobs and phases that declare no lenses', async () => {
    await expect(codeReviewLenses(makeCtx({ job: { type: JobType.PrReview } }), { base: 'main' })).rejects.toThrow(/pr-review job/)
    await expect(codeReviewLenses(makeCtx({ lenses: [] }), { base: 'main' })).rejects.toThrow(/no review lenses/)
    expect(runSubagent).not.toHaveBeenCalled()
  })

  it('routes lenses by file class, runs them in the checkout with project context, and writes the diff', async () => {
    writeFileSync(path.join(root, 'job-1', 'svc', 'README.md'), '# svc\n\nNotes.\n')
    const ctx = makeCtx()
    const result = await codeReviewLenses(ctx, { base: 'main' })

    if (result.status !== 'ok') throw new Error('expected ok')
    // README is docs, so only the code-routed lenses run; the verifier is never routed.
    expect(result.lensesRun).toEqual(['correctness', 'tests', 'security'])
    expect(result.mode).toBe('review')
    expect(result.files).toBe(2)
    expect(runSubagent).toHaveBeenCalledTimes(3)
    const request = runSubagent.mock.calls[0]![0] as { cwd: string; projectContext: string; task: string }
    expect(request.cwd).toBe(path.join(root, 'job-1', 'svc'))
    expect(request.projectContext).toBe('load')
    expect(request.task).toContain('code-review/diff.patch')
    expect(request.task).toContain('Work item under review: add-cache')
    expect(readFileSync(path.join(root, 'job-1', 'code-review', 'diff.patch'), 'utf8')).toContain('=== src/a.ts')
    // The same finding from three lenses is one finding.
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({ title: 'Off by one', severity: 'major', fingerprint: expect.any(String) })
  })

  it('runs only the lenses asked for, and rejects an undeclared one', async () => {
    const ctx = makeCtx()
    const result = await codeReviewLenses(ctx, { base: 'main', lenses: ['security'] })
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.lensesRun).toEqual(['security'])

    await expect(codeReviewLenses(makeCtx(), { base: 'main', lenses: ['architecture'] })).rejects.toThrow(/undeclared lenses: architecture/)
  })

  it('returns the earlier pass as previous and flags repeats', async () => {
    const first = await codeReviewLenses(makeCtx(), { base: 'main', lenses: ['correctness'] })
    if (first.status !== 'ok') throw new Error('expected ok')
    expect(first.pass).toBe(1)
    expect(first.previous).toEqual([])

    runSubagent.mockImplementation(async () => reply([bug, { ...bug, line: 9, title: 'Leaks a handle', category: 'design' }]))
    const second = await codeReviewLenses(makeCtx({ job }), { base: 'main', lenses: ['correctness'] })
    if (second.status !== 'ok') throw new Error('expected ok')
    expect(second.pass).toBe(2)
    expect(second.previous.map(item => item.title)).toEqual(['Off by one'])
    expect(second.findings.find(item => item.title === 'Off by one')?.seenBefore).toBe(true)
    expect(second.findings.find(item => item.title === 'Leaks a handle')?.seenBefore).toBeUndefined()

    // One artefact for the job, one item for the work item.
    expect(job.artifacts!.filter(item => item.kind === CODE_REVIEW_KIND)).toHaveLength(1)
    expect(artifactData().items).toHaveLength(1)
    expect(artifactData().items[0]).toMatchObject({ workItem: 'add-cache', passes: 2, base: 'main' })
  })

  it('keeps work items apart in the same artefact', async () => {
    await codeReviewLenses(makeCtx(), { base: 'main', lenses: ['correctness'], workItem: 'wi-a' })
    await codeReviewLenses(makeCtx({ job }), { base: 'main', lenses: ['correctness'], workItem: 'wi-b' })
    expect(artifactData().items.map(item => item.workItem)).toEqual(['wi-a', 'wi-b'])
  })

  it('lets the verifier keep or drop earlier findings without counting as a pass', async () => {
    runSubagent.mockImplementation(async () => reply([bug, { ...bug, line: 9, title: 'Leaks a handle', category: 'design' }]))
    await codeReviewLenses(makeCtx(), { base: 'main', lenses: ['correctness'] })

    runSubagent.mockImplementation(async () => reply([{ ...bug, severity: 'minor' }]))
    const verified = await codeReviewLenses(makeCtx({ job }), { base: 'main', lenses: ['verifier'], candidates: [bug] })
    if (verified.status !== 'ok') throw new Error('expected ok')

    expect(verified.mode).toBe('verify')
    expect(verified.pass).toBe(1)
    const stored = artifactData().items[0]!
    expect(stored.passes).toBe(1)
    expect(stored.findings.find(item => item.title === 'Off by one')).toMatchObject({ verified: true, severity: 'minor' })
    expect(stored.findings.find(item => item.title === 'Leaks a handle')).toMatchObject({ dropped: true })
  })

  it('reports lens spend through recordUsage, once per call', async () => {
    await codeReviewLenses(makeCtx(), { base: 'main' })
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage).toHaveBeenCalledWith({ inputTokens: 300, outputTokens: 30, costUsd: 1.5 })
  })

  it('applies the severity floor from config', async () => {
    runSubagent.mockImplementation(async () => reply([bug, { ...bug, line: 5, title: 'Naming', severity: 'nit', category: 'style' }]))
    const ctx = makeCtx()
    ;(ctx.settings as { codeReview?: unknown }).codeReview = { lenses: true, minSeverity: 'major' }
    const result = await codeReviewLenses(ctx, { base: 'main', lenses: ['correctness'] })
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.findings.map(item => item.title)).toEqual(['Off by one'])
  })

  it('is unavailable when lenses are off or the executor cannot run subagents', async () => {
    const off = await codeReviewLenses(makeCtx({ codeReview: { lenses: false } }), { base: 'main' })
    expect(off).toMatchObject({ status: 'unavailable' })

    const noSubagents = await codeReviewLenses(
      makeCtx({ executor: { manifest: { id: 'stub' }, capabilities: {} } }),
      { base: 'main' },
    )
    expect(noSubagents).toMatchObject({ status: 'unavailable' })
    expect(runSubagent).not.toHaveBeenCalled()
    expect(job.artifacts).toEqual([])
  })

  it('says so when nothing is in scope', async () => {
    const repo = path.join(root, 'job-1', 'svc')
    git(repo, 'checkout', '-q', '--', 'src/a.ts')
    writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 1\n')
    writeFileSync(path.join(repo, 'README.md'), '# svc\n\nMore docs.\n')
    const result = await codeReviewLenses(makeCtx(), { base: 'main' })
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.lensesRun).toEqual([])
    expect(result.notes[0]).toMatch(/No changed file is in scope/)
    expect(runSubagent).not.toHaveBeenCalled()
  })

  it('fails clearly when the repository is not checked out', async () => {
    rmSync(path.join(root, 'job-1', 'svc'), { recursive: true, force: true })
    await expect(codeReviewLenses(makeCtx(), { base: 'main' })).rejects.toThrow(/not checked out/)
  })
})

describe('lens spend in phase usage', () => {
  it('records the lens part of a snapshot and leaves it out of the session baseline', () => {
    const snapshot = buildPhaseSnapshot({
      phase: 'coding',
      tokens: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      costUsd: 3,
      subagentCostUsd: 1.5,
      durationMs: 1,
      durationApiMs: 1,
      numTurns: 1,
      model: 'm',
      priorUsage: [],
      checkpointPhases: new Set(),
      interactive: false,
      sessionId: 's1',
    })
    expect(snapshot).toMatchObject({ costUsd: 3, subagentCostUsd: 1.5 })
    expect(sessionCostBaseline([snapshot], 's1', 3)).toBe(1.5)
    // Legacy snapshots without a session fall back to the job total, minus lens spend.
    expect(sessionCostBaseline([{ costUsd: 3, subagentCostUsd: 1.5 }], 's1', 3)).toBe(1.5)
    expect(buildPhaseSnapshot({ ...{
      phase: 'coding', tokens: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      costUsd: 0, durationMs: 0, durationApiMs: 0, numTurns: 0, model: 'm', priorUsage: [], checkpointPhases: new Set<string>(), interactive: false,
    } })).not.toHaveProperty('subagentCostUsd')
  })
})
