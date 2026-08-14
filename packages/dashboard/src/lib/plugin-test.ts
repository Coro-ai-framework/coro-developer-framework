// ── Generic plugin connection test ───────────────────────────────────────────
//
// One call for every provider. The runner resolves the plugin and asks it to
// probe its own credentials, so the dashboard never needs to know that
// Bitbucket wants a workspace or that Jira wants a site URL.
//
// This replaced three provider-shaped endpoints (`/test/git`,
// `/test/tracker`, `/test/llm`) whose payload builders had to be edited
// every time a plugin was added — the exact coupling the plugin
// architecture exists to remove.

import { ApiError, jsonRequest, requestJson } from './http'
import type { TestConnectionResult } from '../components/settings/TestConnectionButton'

interface PluginTestResponse {
  ok: boolean
  message?: string
  hint?: string
  checks?: TestConnectionResult['checks']
}

export async function testPluginConnection(
  pluginId: string,
  config: Record<string, unknown>,
): Promise<TestConnectionResult> {
  try {
    const response = await requestJson<PluginTestResponse>(
      `/test/plugin/${encodeURIComponent(pluginId)}`,
      jsonRequest({ config }, { method: 'POST' }),
    )
    const message = response.message ?? (response.ok ? 'Connected.' : 'Connection failed.')
    return {
      ok: response.ok,
      // A hint is remediation for a failure; folding it into the message
      // keeps the single-line button useful without a second surface.
      message: response.hint && !response.ok ? `${message} ${response.hint}` : message,
      ...(response.checks ? { checks: response.checks } : {}),
    }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof ApiError ? err.message : (err as Error).message,
    }
  }
}
