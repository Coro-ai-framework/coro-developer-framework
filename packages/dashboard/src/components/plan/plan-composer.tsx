import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Check } from 'lucide-react'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { findModel } from '../llm/pricing'
import type { ProviderOption } from '../llm/ModelPicker'
import { useExecutorPlugins } from '../llm/useExecutorPlugins'
import { useProviderModels, type ProviderModelDescriptor } from '../llm/useProviderModels'
import { cn } from '../../lib/utils'
import { usePlanSession } from '../../providers/plan-session'

function PlanModeModelSelect({
  value,
  onChange,
  providers,
  modelsByProvider,
  loadModels,
  disabled = false,
}: {
  value: { provider: string; model: string }
  onChange: (next: { provider: string; model: string }) => void
  providers: ProviderOption[]
  modelsByProvider: Record<string, ProviderModelDescriptor[] | null | undefined>
  loadModels: (providerId: string) => Promise<void>
  disabled?: boolean
}) {
  const providerKey = providers.map(p => p.id).join('|')
  useEffect(() => {
    for (const p of providers) void loadModels(p.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerKey])

  const label = useMemo(() => {
    if (!value.model) return 'Planning tier default'
    const descriptor = findModel(modelsByProvider, value.provider, value.model)
    return descriptor?.displayName ?? value.model
  }, [value, modelsByProvider])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className="text-[11px] text-fg-subtle transition-colors hover:text-fg-muted disabled:opacity-50"
        >
          Model: <span className="font-mono text-fg-muted">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="max-h-72 overflow-y-auto">
        {providers.map((p, index) => {
          const models = modelsByProvider[p.id]
          if (!models?.length) return null
          return (
            <div key={p.id}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuLabel>{p.displayName}</DropdownMenuLabel>
              {models.map(m => {
                const selected = value.provider === p.id && value.model === m.id
                return (
                  <DropdownMenuItem
                    key={`${p.id}:${m.id}`}
                    onClick={() => onChange({ provider: p.id, model: m.id })}
                  >
                    <span className={cn(selected && 'text-accent-300')}>{m.displayName}</span>
                    {selected ? <Check className="ml-auto size-3.5 text-accent-300" /> : null}
                  </DropdownMenuItem>
                )
              })}
            </div>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface AutoGrowTextareaProps {
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean
}

function AutoGrowTextarea({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  autoFocus,
}: AutoGrowTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const maxHeight = 10 * 24 + 24
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [value])

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      autoFocus={autoFocus}
      onChange={e => onChange(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault()
          if (!disabled && value.trim()) onSubmit()
        }
      }}
      placeholder={placeholder}
      disabled={disabled}
      className="flex-1 resize-none rounded-2xl border border-line-strong bg-overlay px-4 py-3 text-[13.5px] leading-6 text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60 disabled:cursor-not-allowed disabled:opacity-50"
    />
  )
}

export default function PlanComposer({ blocked = false }: { blocked?: boolean }) {
  const session = usePlanSession()
  const [input, setInput] = useState('')
  const { providers } = useExecutorPlugins()
  const { modelsByProvider, loadModels } = useProviderModels()
  const disabled = blocked || session.busy || session.limitReached || session.noLlm

  const submit = useCallback(() => {
    const text = input
    setInput('')
    void session.send(text)
  }, [input, session])

  return (
    <div className="shrink-0 pb-1 pt-3">
      <form
        onSubmit={e => {
          e.preventDefault()
          if (!disabled && input.trim()) submit()
        }}
        className="flex items-end gap-2"
      >
        <AutoGrowTextarea
          value={input}
          onChange={setInput}
          onSubmit={() => {
            if (!disabled && input.trim()) submit()
          }}
          placeholder="Describe what you want Coro to do… (Shift+Enter for a new line)"
          disabled={disabled}
          autoFocus={!session.hasProgress}
        />
        <Button type="submit" size="icon" disabled={disabled || !input.trim()} aria-label="Send">
          <ArrowUp />
        </Button>
      </form>
      <div className="mt-2 flex items-center justify-between gap-2">
        <PlanModeModelSelect
          value={session.modelChoice}
          onChange={session.setModelChoice}
          providers={providers}
          modelsByProvider={modelsByProvider}
          loadModels={loadModels}
          disabled={session.busy}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              const text = input
              setInput('')
              void session.send(text, { forceBrief: true })
            }}
            className="text-[11px] text-fg-subtle transition-colors hover:text-fg-muted disabled:opacity-50"
          >
            Brief now
          </button>
          <span className="text-[11px] text-fg-subtle">
            {session.turnCount} turns · {session.totalTokens.toLocaleString()} tokens
          </span>
          {session.busy ? (
            <button
              type="button"
              onClick={session.cancel}
              className="text-[11px] text-fg-subtle transition-colors hover:text-fg-muted"
            >
              Stop
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
