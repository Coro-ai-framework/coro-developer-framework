import { z } from 'zod'

export const openAiConfigSchema = z.object({
  apiKey: z.string().optional().describe('OpenAI API key. Falls back to OPENAI_API_KEY when omitted.'),
  baseURL: z.string().url().optional().describe('Optional OpenAI-compatible base URL.'),
  organization: z.string().optional().describe('Optional OpenAI organization id.'),
  project: z.string().optional().describe('Optional OpenAI project id.'),
  defaultModel: z.string().optional().describe('Optional default model for dashboard seeding.'),
}).passthrough()

export type OpenAiExecutorSettings = Record<string, never>
export type OpenAiAuthConfig = z.infer<typeof openAiConfigSchema>

export interface OpenAiClientOptions {
  apiKey?: string
  baseURL?: string
  organization?: string
  project?: string
}
