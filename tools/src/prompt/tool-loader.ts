import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import type Anthropic from '@anthropic-ai/sdk'

// ── Raw YAML shape ────────────────────────────────────────────────────────────

interface RawToolDef {
  name: string
  description: string
  input_schema: {
    properties: Record<string, unknown>
    required?: string[]
  }
}

// ── Loader ────────────────────────────────────────────────────────────────────

/**
 * Load tool definitions from the YAML config file and convert them into
 * the Anthropic SDK's Tool format.
 *
 * The YAML entries omit `type: "object"` on the top-level input_schema —
 * the loader adds it so the YAML stays concise and human-editable.
 */
export async function loadToolDefinitions(a5aiDir: string): Promise<Anthropic.Tool[]> {
  const yamlPath = path.join(a5aiDir, 'config', 'tool-definitions.yaml')
  const content = await fs.readFile(yamlPath, 'utf-8')
  const raw = yaml.load(content) as RawToolDef[]

  if (!Array.isArray(raw)) {
    throw new Error(`tool-definitions.yaml must be a YAML array, got ${typeof raw}`)
  }

  return raw.map(entry => ({
    name: entry.name,
    description: entry.description.trim(),
    input_schema: {
      type: 'object' as const,
      properties: entry.input_schema.properties ?? {},
      required: entry.input_schema.required ?? [],
    },
  }))
}
