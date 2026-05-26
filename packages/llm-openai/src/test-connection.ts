// ── OpenAI credential probe ─────────────────────────────────────────────────
//
// Active "does this auth actually work?" check invoked by the dashboard's
// "Test connection" button via `POST /test/llm` →
// `OpenAiExecutor.testConnection()`. Mirrors the Anthropic plugin's
// `test-connection.ts` so the runner core can stay provider-agnostic.
//
// We hit `GET <baseURL>/models` (cheap, returns a model list, requires
// auth) rather than spending real inference tokens to validate the key.

import type { PluginTestResult } from '@coro-ai/plugin-sdk'
import type { OpenAiAuthConfig } from './types'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/**
 * Probe the configured OpenAI-compatible endpoint with the supplied
 * credentials. `config` is the merged draft + on-disk config; secrets
 * already resolved upstream by the runner.
 *
 * Never throws — every failure path returns `{ ok: false, message, … }`.
 */
export async function testOpenAiCredentials(
  config: OpenAiAuthConfig,
): Promise<PluginTestResult> {
  const apiKey = (config.apiKey ?? '').trim()
  if (!apiKey) {
    return { ok: false, message: 'An OpenAI API key is required.' }
  }
  const baseURL = (config.baseURL ?? '').trim() || DEFAULT_BASE_URL
  const url = `${baseURL.replace(/\/$/, '')}/models`

  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(config.organization ? { 'OpenAI-Organization': config.organization } : {}),
        ...(config.project ? { 'OpenAI-Project': config.project } : {}),
      },
    })
  } catch (err) {
    return {
      ok: false,
      message: `Could not reach OpenAI endpoint: ${(err as Error).message}`,
    }
  }

  if (response.ok) {
    const data = (await response.json().catch(() => ({}))) as { data?: Array<{ id?: string }> }
    const count = Array.isArray(data?.data) ? data.data.length : 0
    return {
      ok: true,
      message: count > 0
        ? `OpenAI endpoint accepted the key (${count} models available).`
        : 'OpenAI endpoint accepted the key.',
    }
  }

  const status = response.status
  const detail = await describeFailure(response)
  const hint =
    status === 401
      ? 'The key was rejected. Verify the value and that the key still exists in your OpenAI account.'
      : status === 403
        ? 'The key authenticated but does not have access to /models. Check the project / organization scope.'
        : status === 429
          ? 'Rate limited. The key is valid; finish setup and try again.'
          : undefined
  return {
    ok: false,
    message: `OpenAI ${detail}`,
    ...(hint ? { hint } : {}),
  }
}

async function describeFailure(response: Response): Promise<string> {
  const status = response.status
  const text = await response.text().catch(() => '')
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    parsed = null
  }
  const errorObj =
    parsed && typeof parsed === 'object' && 'error' in parsed
      ? (parsed as { error: { message?: string } }).error
      : null
  const msg = errorObj?.message ?? text.slice(0, 200) ?? 'Unknown error'
  return `HTTP ${status} — ${msg}`
}
