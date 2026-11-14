#!/usr/bin/env node
'use strict'

/**
 * A stand-in for `coro start`, faithful enough to exercise the harness and
 * nothing more. It speaks the four routes the harness uses and acts out a
 * scripted behaviour picked by a `[fake:<mode>]` marker in the ticket text:
 *
 *   solve       open a PR with the real fix, park on it, merge it once approved
 *   wrong       open a PR that does not fix the problem
 *   fail        the job fails at once
 *   escalate    the job escalates
 *   park        the job parks waiting for a developer
 *   hang        the job never finishes (until cancelled)
 *   crash       the process dies shortly after accepting the job
 *
 * It reads HOME like the real runner does, so it can only touch the attempt's
 * isolated home, and it writes its pull requests where the local SCM plugin
 * does, which is what the harness's simulated reviewer works on.
 */

const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const args = process.argv.slice(2)
const flag = name => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const port = Number(flag('-p'))
const config = JSON.parse(fs.readFileSync(flag('--config'), 'utf-8'))
const home = os.homedir()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const jobs = new Map()
const logs = new Map()
const cancelled = new Set()
let counter = 0

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf-8' })
const log = (job, line) => logs.get(job.id).push(line)
const stopped = status => ['complete', 'failed', 'escalated', 'cancelled'].includes(status)

function setStatus(job, status, phase) {
  if (cancelled.has(job.id) && status !== 'cancelled') return
  job.status = status
  job.phase = phase ?? job.phase
  log(job, `status ${status} (${job.phase})`)
}

function addPhase(job, phase, costUsd, durationMs, attribution) {
  job.phaseUsage.push({
    phase,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd,
    durationMs,
    durationApiMs: durationMs,
    numTurns: 3,
    model: 'fake-model',
    attribution,
  })
  job.tokenUsage.inputTokens += 1000
  job.tokenUsage.outputTokens += 200
  job.tokenUsage.totalCostUsd = Math.round((job.tokenUsage.totalCostUsd + costUsd) * 1e6) / 1e6
}

function newJob(body) {
  const id = `job-${Date.now()}-${++counter}`
  const job = {
    id,
    type: body.type,
    workflowPath: body.workflowPath,
    params: {
      repo: body.repo,
      description: body.description,
      // Evidence for the tests of what the harness gave this process.
      home,
      apiKeyLength: String(config?.plugins?.installed?.anthropic?.config?.apiKey ?? '').length,
      aliases: config?.llm?.aliases ?? null,
      lenses: config?.codeReview?.lenses ?? null,
      envLeaks: ['CORO_CODING_MODEL', 'CLAUDECODE', 'INIT_CWD', 'npm_lifecycle_event'].filter(key => key in process.env),
    },
    triggerSource: 'cli',
    status: 'queued',
    phase: 'planning',
    currentWorkItem: null,
    workItems: [],
    workItemLoopCount: 0,
    prMappings: [],
    interactive: false,
    artifacts: [],
    phaseUsage: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalCostUsd: 0 },
  }
  jobs.set(id, job)
  logs.set(id, [])
  return job
}

function storeFile(repo) {
  const dir = path.join(home, '.coro', 'local-scm')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${repo.replace(/[^\w.-]+/g, '_')}.json`)
}

async function deliver(job, fix) {
  const repo = job.params.repo
  setStatus(job, 'planning', 'planning')
  addPhase(job, 'planning', 0.25, 1000, 'work-item')
  await sleep(100)

  setStatus(job, 'coding', 'coding')
  const branch = `coro/${job.id}`
  git(repo, 'checkout', '-q', '-b', branch)
  if (fix) {
    const file = path.join(repo, 'src', 'math.js')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('a - b', 'a + b'))
  } else {
    fs.writeFileSync(path.join(repo, 'NOTES.md'), 'I did not fix it.\n')
  }
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'work')
  git(repo, 'checkout', '-q', 'main')
  addPhase(job, 'coding', 1.25, 3000, 'work-item')
  job.workItems = [{ name: 'wi-1', status: 'in-progress', loopCount: 0 }]
  job.artifacts.push({ kind: 'pr-preview', data: { sourceBranch: branch } })

  const file = storeFile(repo)
  fs.writeFileSync(
    file,
    JSON.stringify([{ id: '1', title: 'work', sourceBranch: branch, targetBranch: 'main', state: 'open', approvalCount: 0, comments: [] }]),
  )
  job.prMappings.push({ prId: 1, workItem: 'wi-1', repoSlug: 'sandbox', openedAt: new Date().toISOString() })
  setStatus(job, 'awaiting-pr-merge', 'review')

  for (;;) {
    if (cancelled.has(job.id)) return
    const records = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (records[0] && records[0].approvalCount >= 1) {
      records[0].state = 'merged'
      fs.writeFileSync(file, JSON.stringify(records))
      break
    }
    await sleep(50)
  }

  job.workItems[0].status = 'complete'
  job.prMappings[0].mergedAt = new Date().toISOString()
  addPhase(job, 'review', 0, 500, 'work-item')
  setStatus(job, 'complete', 'evaluation')
}

async function hang(job) {
  setStatus(job, 'coding', 'coding')
  while (!cancelled.has(job.id)) await sleep(50)
}

async function act(job, mode) {
  try {
    if (mode === 'solve') await deliver(job, true)
    else if (mode === 'wrong') await deliver(job, false)
    else if (mode === 'fail') setStatus(job, 'failed', 'coding')
    else if (mode === 'escalate') {
      job.escalationMessage = 'The ticket is ambiguous; asking a human.'
      setStatus(job, 'escalated', 'planning')
    } else if (mode === 'park') setStatus(job, 'awaiting-developer-input', 'planning')
    else if (mode === 'hang') await hang(job)
    else if (mode === 'crash') {
      setStatus(job, 'coding', 'coding')
      await sleep(300)
      process.exit(1)
    } else setStatus(job, 'failed', 'planning')
  } catch (error) {
    log(job, `fake runner error: ${error && error.message}`)
    setStatus(job, 'failed', job.phase)
  }
}

const readBody = req =>
  new Promise(resolve => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
  })

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)

  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok' })

  if (req.method === 'POST' && url.pathname === '/jobs') {
    const body = JSON.parse((await readBody(req)) || '{}')
    if (!body.workflowPath || !body.repo || !body.description) return send(res, 400, { error: 'workflowPath, repo and description are required' })
    const job = newJob(body)
    const mode = /\[fake:([\w-]+)\]/.exec(body.description)?.[1] ?? 'fail'
    void act(job, mode)
    return send(res, 202, { jobId: job.id, type: job.type, status: job.status, streamUrl: `/jobs/${job.id}/stream` })
  }

  if (parts[0] === 'jobs' && parts[1]) {
    const job = jobs.get(decodeURIComponent(parts[1]))
    if (!job) return send(res, 404, { error: 'not found' })

    if (req.method === 'GET' && parts.length === 2) return send(res, 200, job)

    if (req.method === 'POST' && parts[2] === 'cancel') {
      if (!stopped(job.status)) {
        cancelled.add(job.id)
        job.status = 'cancelled'
      }
      return send(res, 200, { ok: true })
    }

    if (req.method === 'GET' && parts[2] === 'stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let sent = 0
      for (;;) {
        const lines = logs.get(job.id)
        while (sent < lines.length) res.write(`data: ${lines[sent++]}\n\n`)
        if (stopped(job.status)) break
        await sleep(50)
      }
      res.write(`event: done\ndata: ${job.status}\n\n`)
      return res.end()
    }
  }

  send(res, 404, { error: 'not found' })
})

server.listen(port, '127.0.0.1')
process.on('SIGTERM', () => process.exit(0))
