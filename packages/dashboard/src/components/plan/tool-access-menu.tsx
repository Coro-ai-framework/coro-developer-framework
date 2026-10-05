import { SegmentedControl } from '../ui/segmented-control'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { usePlanSession } from '../../providers/plan-session'
import type { IntakeBuiltinCapability, ToolAccessMode } from '../../lib/intake-investigation'

const MODES: Array<{ value: ToolAccessMode; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'ask', label: 'Ask' },
  { value: 'allow', label: 'Allow' },
]

const ROWS: Array<{ key: IntakeBuiltinCapability; label: string }> = [
  { key: 'files', label: 'Read files' },
  { key: 'filesWrite', label: 'Write scratch files' },
  { key: 'shell', label: 'Shell' },
  { key: 'web', label: 'Web' },
]

export default function ToolAccessMenu() {
  const session = usePlanSession()
  const view = session.toolAccess
  if (!view) return null

  const mcpOn = Object.values(view.resolved.mcp).filter(mode => mode !== 'off').length
  const builtinOn = ROWS.filter(row => view.resolved.capabilities[row.key] !== 'off').length
  const onCount = builtinOn + mcpOn

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="text-[11px] text-fg-subtle transition-colors hover:text-fg-muted">
          Tools: <span className="font-mono text-fg-muted">{onCount} on</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-80 p-2">
        <DropdownMenuLabel>This conversation</DropdownMenuLabel>
        <div className="space-y-2 px-1 py-1">
          {ROWS.map(row => (
            <div key={row.key} className="flex items-center justify-between gap-2">
              <span className="text-[12px] text-fg">{row.label}</span>
              <SegmentedControl
                size="sm"
                ariaLabel={row.label}
                options={MODES}
                value={view.resolved.capabilities[row.key]}
                onChange={value => void session.updateToolAccess({ capabilities: { [row.key]: value } })}
              />
            </div>
          ))}
        </div>
        {view.catalog.mcpServers.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>MCP servers</DropdownMenuLabel>
            <div className="space-y-2 px-1 py-1">
              {view.catalog.mcpServers.map(server => {
                const mode = view.resolved.mcp[server.id] ?? 'off'
                const attachesLater = mode !== 'off' && !server.planMode
                return (
                  <div key={server.id}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[12px] text-fg">{server.id}</span>
                      <SegmentedControl
                        size="sm"
                        ariaLabel={server.id}
                        options={MODES}
                        value={mode}
                        onChange={value => void session.updateToolAccess({ mcp: { [server.id]: value } })}
                      />
                    </div>
                    {attachesLater ? (
                      <p className="text-[10px] text-fg-subtle">attaches next message</p>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </>
        ) : null}
        {(view.toolAccess?.allow.length ?? 0) > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Allowed here</DropdownMenuLabel>
            <div className="flex flex-wrap gap-1 px-1 py-1">
              {view.toolAccess!.allow.map(rule => (
                <button
                  key={rule}
                  type="button"
                  className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] text-fg-muted hover:text-fg"
                  title="Remove this rule"
                  onClick={() => void session.updateToolAccess({
                    allow: view.toolAccess!.allow.filter(item => item !== rule),
                  })}
                >
                  {rule} ×
                </button>
              ))}
            </div>
          </>
        ) : null}
        <p className="px-2 pt-2 text-[10px] text-fg-subtle">Defaults: Settings → General</p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
