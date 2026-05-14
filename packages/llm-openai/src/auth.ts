import type { OpenAiAuthConfig, OpenAiClientOptions } from './types'

export function resolveOpenAiClientOptions(auth: OpenAiAuthConfig = {}): OpenAiClientOptions {
  return {
    apiKey: auth.apiKey || process.env['OPENAI_API_KEY'],
    ...(auth.baseURL ? { baseURL: auth.baseURL } : {}),
    ...(auth.organization ? { organization: auth.organization } : {}),
    ...(auth.project ? { project: auth.project } : {}),
  }
}

export function hasOpenAiApiKey(auth: OpenAiAuthConfig = {}): boolean {
  return typeof resolveOpenAiClientOptions(auth).apiKey === 'string'
    && resolveOpenAiClientOptions(auth).apiKey!.length > 0
}
