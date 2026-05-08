import { useEffect, useState, type ChangeEvent } from 'react'
import { RefreshCcw } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Switch } from '../../../components/ui/switch'
import { Textarea } from '../../../components/ui/textarea'
import SettingsSection from '../../../components/settings/SettingsSection'
import SettingsNotice from '../../../components/settings/SettingsNotice'
import { useSettings, type McpServerEntry } from '../SettingsContext'
import { requestJson } from '../../../lib/http'

const EXAMPLE_BLOCK = `{
  "slack": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-slack"],
    "env": { "SLACK_BOT_TOKEN": "xoxb-…" },
    "allowedTools": ["list_channels", "search_messages"]
  },
  "sentry": {
    "type": "http",
    "url": "https://mcp.sentry.io",
    "headers": { "Authorization": "Bearer …" }
  },
  "datadog": {
    "type": "sse",
    "url": "https://mcp.datadoghq.com/sse",
    "enabled": false
  }
}`

export default function McpServersSection() {
  const { draft, setDraft } = useSettings()
  const [parseError, setParseError] = useState<string | null>(null)
  const [claudeCodeMcps, setClaudeCodeMcps] = useState<{
    servers: Record<string, McpServerEntry>
    sources: string[]
  } | null>(null)
  const [claudeCodeMcpsLoading, setClaudeCodeMcpsLoading] = useState(false)

  // Validate JSON as the user types so they see feedback before hitting Save.
  useEffect(() => {
    try {
      const parsed = JSON.parse(draft.mcpServersText)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setParseError('mcpServers must be a JSON object keyed by server id.')
      } else {
        setParseError(null)
      }
    } catch (err) {
      setParseError(`Invalid JSON: ${(err as Error).message}`)
    }
  }, [draft.mcpServersText])

  async function loadClaudeCodeMcps() {
    try {
      setClaudeCodeMcpsLoading(true)
      const data = await requestJson<{ servers: Record<string, McpServerEntry>; sources: string[] }>(
        '/config/claude-code-mcps',
      )
      setClaudeCodeMcps(data)
    } catch {
      setClaudeCodeMcps(null)
    } finally {
      setClaudeCodeMcpsLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Bring-your-own MCP servers"
        description="Attach any MCP server (Slack, Sentry, Datadog, internal tooling…) to every job session. The runner spawns each entry alongside the in-process `coro` server; agents see them as `mcp__<id>__*`."
        footer={
          <span>
            Reserved id <code>coro</code> is rejected. Use <code>"enabled": false</code> to keep an entry without attaching it.
            <code> allowedTools</code> / <code>disallowedTools</code> become per-server tool policy. Changes save with the rest of the page.
          </span>
        }
      >
        <Textarea
          value={draft.mcpServersText}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setDraft('mcpServersText', e.target.value)}
          spellCheck={false}
          rows={14}
          className="font-mono text-[12px]"
        />
        {parseError ? <SettingsNotice tone="danger">{parseError}</SettingsNotice> : null}
      </SettingsSection>

      <SettingsSection
        title="Inherit from Claude Code"
        description="When enabled, the runner reads MCP servers from your user-level Claude Code config (~/.claude.json and ~/.claude/settings.json) and attaches them to every job session. Explicit BYO entries above override inherited entries with the same id."
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadClaudeCodeMcps()}
            disabled={claudeCodeMcpsLoading}
          >
            <RefreshCcw />
            {claudeCodeMcpsLoading ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      >
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-overlay/40 px-4 py-3.5">
          <div className="min-w-0">
            <div className="text-sm font-medium text-fg">Inherit Claude Code MCP servers</div>
            <div className="text-[12px] text-fg-muted">
              Off by default — Claude Code configs commonly carry developer-personal entries (Notion, GitHub Personal…) that an operator may not want every job to see.
            </div>
          </div>
          <Switch
            checked={draft.inheritClaudeCodeMcps}
            onCheckedChange={next => setDraft('inheritClaudeCodeMcps', next)}
            ariaLabel="Inherit Claude Code MCP servers"
          />
        </div>

        {claudeCodeMcps ? (
          <div className="space-y-3">
            {claudeCodeMcps.sources.length > 0 ? (
              <div className="text-[12px] text-fg-muted">
                Read from{' '}
                {claudeCodeMcps.sources.map((src, i) => (
                  <span key={src} className="font-mono">
                    {i > 0 ? ', ' : ''}
                    {src}
                  </span>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5 text-sm text-fg-muted">
                No Claude Code MCP servers found. Add one with <code>claude mcp add &lt;name&gt; --scope user</code> or paste an entry into <code>~/.claude.json</code> under <code>mcpServers</code>.
              </div>
            )}
            {Object.keys(claudeCodeMcps.servers).length > 0 ? (
              <pre className="overflow-auto rounded-2xl border border-line bg-overlay/40 px-4 py-3.5 text-[12px] text-fg-muted">
                {JSON.stringify(claudeCodeMcps.servers, null, 2)}
              </pre>
            ) : null}
          </div>
        ) : (
          <div className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5 text-sm text-fg-muted">
            {claudeCodeMcpsLoading
              ? 'Loading discovered servers…'
              : 'Click Refresh to preview the MCP servers Claude Code currently exposes.'}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="Examples"
        description="Drop these into the editor above. Replace placeholder secrets with real ones — values containing `...` are treated as redacted echoes and ignored on save."
      >
        <pre className="overflow-auto rounded-2xl border border-line bg-overlay/40 px-4 py-3.5 text-[12px] text-fg-muted">
          {EXAMPLE_BLOCK}
        </pre>
      </SettingsSection>
    </div>
  )
}
