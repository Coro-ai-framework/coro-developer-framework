import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Investigation } from '@coro-ai/cloud-protocol'
import {
  materializePlanContext,
  PLAN_CONTEXT_DIR,
  PLAN_FINDINGS_FILE,
  PLAN_FINDINGS_MAX_CHARS,
  renderPlanFindingsDocument,
} from '../../src/jobs/plan-context'

function makeInvestigation(overrides: Partial<Investigation> = {}): Investigation {
  return {
    id: 'inv-plan-1',
    title: 'Rate limit /api/users',
    status: 'active',
    items: [],
    turns: [],
    modelChoice: { provider: 'anthropic', model: 'claude-opus' },
    readiness: {
      state: 'ready',
      openQuestions: [],
      note: 'clear enough to run',
    },
    findings: '## Decode path\n\nThe handler is stateless.',
    turnCount: 2,
    tokens: 80,
    contextUsed: 80,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T01:00:00.000Z',
    ...overrides,
  }
}

describe('renderPlanFindingsDocument', () => {
  it('frames the write-up with provenance and a readiness line', () => {
    const doc = renderPlanFindingsDocument(makeInvestigation())
    expect(doc).toContain('# Plan-mode investigation findings')
    expect(doc).toContain('Investigation `inv-plan-1`')
    expect(doc).toContain('captured 2026-01-01T01:00:00.000Z')
    expect(doc).toContain('anthropic/claude-opus')
    expect(doc).toContain('## Decode path')
    expect(doc).toContain('The handler is stateless.')
    expect(doc).toContain('*Readiness at dispatch: ready — clear enough to run*')
    expect(doc).not.toContain('## Still open at dispatch')
    expect(doc).toContain('re-read any file you intend to change')
  })

  it('lists open questions when readiness still has them', () => {
    const doc = renderPlanFindingsDocument(makeInvestigation({
      readiness: {
        state: 'investigating',
        openQuestions: ['which timeout?', 'who owns retries?'],
        note: 'two unknowns',
      },
    }))
    expect(doc).toContain('## Still open at dispatch')
    expect(doc).toContain('- which timeout?')
    expect(doc).toContain('- who owns retries?')
    expect(doc).toContain('*Readiness at dispatch: investigating — two unknowns*')
  })

  it('omits the readiness line when readiness is null', () => {
    const doc = renderPlanFindingsDocument(makeInvestigation({ readiness: null }))
    expect(doc).not.toContain('Readiness at dispatch')
    expect(doc).not.toContain('## Still open at dispatch')
  })

  it('returns null for empty findings', () => {
    expect(renderPlanFindingsDocument(makeInvestigation({ findings: null }))).toBeNull()
    expect(renderPlanFindingsDocument(makeInvestigation({ findings: '   ' }))).toBeNull()
  })

  it('truncates a write-up over the cap', () => {
    const findings = 'x'.repeat(PLAN_FINDINGS_MAX_CHARS + 50)
    const doc = renderPlanFindingsDocument(makeInvestigation({ findings }))
    expect(doc).toContain('*[truncated — investigation write-up exceeded 64 KiB]*')
    expect(doc).toContain('x'.repeat(100))
    expect(doc?.includes('x'.repeat(PLAN_FINDINGS_MAX_CHARS + 1))).toBe(false)
  })
})

describe('materializePlanContext', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'coro-plan-ctx-'))
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('writes plan/findings.md and returns the posix relative path', async () => {
    const investigation = makeInvestigation()
    const result = await materializePlanContext({
      investigationId: investigation.id,
      jobWorkingDir: tmp,
      stateBackend: { getInvestigation: async () => investigation },
    })
    expect(result).toEqual({ relativePath: `${PLAN_CONTEXT_DIR}/${PLAN_FINDINGS_FILE}` })
    const written = await fs.readFile(path.join(tmp, PLAN_CONTEXT_DIR, PLAN_FINDINGS_FILE), 'utf8')
    expect(written).toContain('## Decode path')
  })

  it('overwrites an existing file', async () => {
    await fs.mkdir(path.join(tmp, PLAN_CONTEXT_DIR), { recursive: true })
    await fs.writeFile(path.join(tmp, PLAN_CONTEXT_DIR, PLAN_FINDINGS_FILE), 'stale', 'utf8')
    await materializePlanContext({
      investigationId: 'inv-plan-1',
      jobWorkingDir: tmp,
      stateBackend: { getInvestigation: async () => makeInvestigation({ findings: '## Fresh' }) },
    })
    const written = await fs.readFile(path.join(tmp, PLAN_CONTEXT_DIR, PLAN_FINDINGS_FILE), 'utf8')
    expect(written).toContain('## Fresh')
    expect(written).not.toContain('stale')
  })

  it('returns null when the row is missing or findings are empty', async () => {
    expect(await materializePlanContext({
      investigationId: 'missing',
      jobWorkingDir: tmp,
      stateBackend: { getInvestigation: async () => null },
    })).toBeNull()
    expect(await materializePlanContext({
      investigationId: 'inv-plan-1',
      jobWorkingDir: tmp,
      stateBackend: { getInvestigation: async () => makeInvestigation({ findings: null }) },
    })).toBeNull()
    await expect(fs.access(path.join(tmp, PLAN_CONTEXT_DIR))).rejects.toThrow()
  })
})
