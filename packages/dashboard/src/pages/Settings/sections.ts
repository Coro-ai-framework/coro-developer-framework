import type { LucideIcon } from 'lucide-react'
import {
  Bot,
  FolderTree,
  GitBranch,
  Plug,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Ticket,
} from 'lucide-react'
import type { SettingsSectionId } from './SettingsContext'

export interface SettingsSectionDescriptor {
  id: SettingsSectionId
  /** Sidebar group bucket. */
  group: 'setup' | 'extensions' | 'advanced'
  /** Human label for the sidebar nav row. */
  label: string
  /** One-line description shown under the label on the section page. */
  description: string
  icon: LucideIcon
  /** True when missing config blocks job dispatch. */
  required: boolean
}

export const SETTINGS_SECTIONS: SettingsSectionDescriptor[] = [
  {
    id: 'general',
    group: 'setup',
    label: 'General',
    description: 'Coach mode and new-run intake preferences.',
    icon: SlidersHorizontal,
    required: false,
  },
  {
    id: 'llm-provider',
    group: 'setup',
    label: 'LLM provider',
    description: 'Authenticate the runner against the model that drives every job.',
    icon: Bot,
    required: true,
  },
  {
    id: 'source-control',
    group: 'setup',
    label: 'Source control',
    description: 'Git credentials used for clone, branch, push, and PR operations.',
    icon: GitBranch,
    required: true,
  },
  {
    id: 'issue-tracker',
    group: 'setup',
    label: 'Issue tracker',
    description: 'Optional. Used by campaigns when they need to file an epic + child issues.',
    icon: Ticket,
    required: false,
  },
  {
    id: 'plugins',
    group: 'extensions',
    label: 'Plugins',
    description: 'Provider integrations the runner has loaded plus drop-in installation.',
    icon: Plug,
    required: false,
  },
  {
    id: 'mcp',
    group: 'extensions',
    label: 'MCP servers',
    description: 'Bring-your-own MCP servers and Claude Code inheritance.',
    icon: Server,
    required: false,
  },
  {
    id: 'guardrails',
    group: 'extensions',
    label: 'Guardrails',
    description: 'Policies the runner enforces before agents open PRs or call tools.',
    icon: ShieldCheck,
    required: false,
  },
  {
    id: 'paths',
    group: 'advanced',
    label: 'Paths',
    description: 'Filesystem locations for intelligence overlays and working repositories.',
    icon: FolderTree,
    required: false,
  },
]

export const GROUP_LABELS: Record<'setup' | 'extensions' | 'advanced', { title: string; hint: string }> = {
  setup: {
    title: 'Setup',
    hint: 'Required to run jobs. Finish these first.',
  },
  extensions: {
    title: 'Extensions',
    hint: 'Opt-in capabilities. Add when you need them.',
  },
  advanced: {
    title: 'Advanced',
    hint: 'Rarely changed. Defaults work for most installs.',
  },
}

export function getSectionDescriptor(id: SettingsSectionId): SettingsSectionDescriptor {
  const found = SETTINGS_SECTIONS.find(section => section.id === id)
  if (!found) throw new Error(`Unknown settings section id: ${id}`)
  return found
}
