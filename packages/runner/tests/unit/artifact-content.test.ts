import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import {
  ArtifactPathEscapeError,
  readJobArtifactFile,
  resolveJobArtifactPath,
} from '../../src/jobs/artifact-content'

describe('resolveJobArtifactPath', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'coro-artifact-content-'))
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('resolves a relative path under the job working directory', () => {
    const resolved = resolveJobArtifactPath(tmp, 'job-1', 'plan.md')
    expect(resolved).toBe(path.join(tmp, 'job-1', 'plan.md'))
  })

  it('rejects a path that escapes the job working directory', () => {
    expect(() => resolveJobArtifactPath(tmp, 'job-1', '../secret.txt')).toThrow(ArtifactPathEscapeError)
  })

  it('reads a confined file as utf-8', async () => {
    const jobDir = path.join(tmp, 'job-1')
    await fs.mkdir(jobDir, { recursive: true })
    await fs.writeFile(path.join(jobDir, 'plan.md'), '# Plan\n', 'utf-8')
    await expect(readJobArtifactFile(tmp, 'job-1', 'plan.md')).resolves.toBe('# Plan\n')
  })
})
