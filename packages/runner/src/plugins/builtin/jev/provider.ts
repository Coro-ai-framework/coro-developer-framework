import type { DecisionAnswer } from '@coro-ai/cloud-protocol'
import type { DecisionSettings } from '../../../config/settings'
import type {
  DecisionAsk,
  DecisionProvider,
  DecisionResult,
  DecisionSuccess,
} from '../../../clients/decision/types'
import { JEV_DEFAULT_BASE_URL, JEV_PROVIDER_ID } from './defaults'

interface JevResponseBody {
  model?: string
  answers?: Record<string, unknown>
  usage?: { input_tokens?: number }
}

function unavailable(reason: string): DecisionResult {
  return { available: false, reason }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as { name?: unknown }).name
  return name === 'AbortError' || name === 'TimeoutError'
}

function parseAnswer(raw: unknown): DecisionAnswer | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const rec = raw as Record<string, unknown>
  const type = rec['type']
  if (type === 'noul') {
    const noul = rec['noul']
    if (typeof noul !== 'number' || !Number.isFinite(noul)) return undefined
    return { type: 'noul', noul }
  }
  if (type === 'choice') {
    const choice = rec['choice']
    const confidence = rec['confidence']
    const probabilities = rec['probabilities']
    if (typeof choice !== 'string') return undefined
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return undefined
    if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) return undefined
    const probs: Record<string, number> = {}
    for (const [k, v] of Object.entries(probabilities as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) probs[k] = v
    }
    return { type: 'choice', choice, confidence, probabilities: probs }
  }
  if (type === 'score') {
    const score = rec['score']
    const confidence = rec['confidence']
    const probabilities = rec['probabilities']
    if (typeof score !== 'number' || !Number.isFinite(score)) return undefined
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return undefined
    if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) return undefined
    const probs: Record<string, number> = {}
    for (const [k, v] of Object.entries(probabilities as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) probs[k] = v
    }
    return { type: 'score', score, confidence, probabilities: probs }
  }
  return undefined
}

function parseSuccess(body: JevResponseBody, latencyMs: number, fallbackModel: string): DecisionResult {
  if (!body.answers || typeof body.answers !== 'object') {
    return unavailable('Decision provider returned a body with no answers')
  }
  const answers: Record<string, DecisionAnswer> = {}
  for (const [id, raw] of Object.entries(body.answers)) {
    const parsed = parseAnswer(raw)
    if (!parsed) return unavailable(`Decision provider returned a malformed answer for "${id}"`)
    answers[id] = parsed
  }
  const result: DecisionSuccess = {
    available: true,
    model: typeof body.model === 'string' && body.model.length > 0 ? body.model : fallbackModel,
    latencyMs,
    inputTokens: typeof body.usage?.input_tokens === 'number' ? body.usage.input_tokens : 0,
    answers,
  }
  return result
}

function retryAfterMs(res: Response): number {
  const header = res.headers.get('retry-after')
  if (!header) return 0
  const asNumber = Number(header)
  if (Number.isFinite(asNumber) && asNumber >= 0) return Math.min(asNumber * 1000, 5_000)
  const asDate = Date.parse(header)
  if (Number.isFinite(asDate)) return Math.max(0, Math.min(asDate - Date.now(), 5_000))
  return 0
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * HTTP adapter for one decision provider. The rest of the runner sees only
 * {@link DecisionProvider}. Failures resolve to `{ available: false }` and
 * never throw.
 */
export class JevDecisionProvider implements DecisionProvider {
  readonly providerId = JEV_PROVIDER_ID

  constructor(private readonly settings: DecisionSettings) {}

  async ask(req: DecisionAsk): Promise<DecisionResult> {
    try {
      return await this.askOnce(req, true)
    } catch (err) {
      if (isAbortError(err)) {
        return unavailable(`Decision provider timed out after ${this.settings.timeoutMs}ms`)
      }
      const message = err instanceof Error ? err.message : String(err)
      return unavailable(`Decision provider request failed: ${message}`)
    }
  }

  private async askOnce(req: DecisionAsk, allowRetry: boolean): Promise<DecisionResult> {
    const started = Date.now()
    const origin = this.settings.baseUrl.trim() || JEV_DEFAULT_BASE_URL
    const url = `${origin.replace(/\/$/, '')}/v1/systemone`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.settings.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.settings.model,
        state: req.state,
        questions: req.questions,
      }),
      signal: AbortSignal.timeout(this.settings.timeoutMs),
    })
    const latencyMs = Date.now() - started

    if (res.status === 429 && allowRetry) {
      const wait = retryAfterMs(res)
      if (wait > 0 && wait < this.settings.timeoutMs) {
        await sleep(wait)
        return this.askOnce(req, false)
      }
      const text = await res.text().catch(() => '')
      return unavailable(`Decision provider rate-limited (429)${text ? `: ${text.slice(0, 200)}` : ''}`)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return unavailable(`Decision provider returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
    }

    let body: JevResponseBody
    try {
      body = await res.json() as JevResponseBody
    } catch {
      return unavailable('Decision provider returned a non-JSON body')
    }
    return parseSuccess(body, latencyMs, this.settings.model)
  }
}
