import { useEffect, useMemo, useState, type ComponentType } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCcw,
  RotateCcw,
  Sparkles,
  XCircle,
} from 'lucide-react'
import PageHeader from '../../components/common/page-header'
import ErrorState from '../../components/common/error-state'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import SettingsStatusBadge, {
  type SettingStatus,
} from '../../components/settings/StatusBadge'
import SettingsNotice from '../../components/settings/SettingsNotice'
import { cn } from '../../lib/utils'
import { useSettings, type SettingsSectionId } from './SettingsContext'
import {
  GROUP_LABELS,
  SETTINGS_SECTIONS,
  getSectionDescriptor,
} from './sections'
import { evaluateReadiness } from './readiness'

import LlmProviderSection from './sections/LlmProviderSection'
import SourceControlSection from './sections/SourceControlSection'
import IssueTrackerSection from './sections/IssueTrackerSection'
import PluginsSection from './sections/PluginsSection'
import McpServersSection from './sections/McpServersSection'
import PathsSection from './sections/PathsSection'

const SECTION_COMPONENTS: Record<SettingsSectionId, ComponentType> = {
  'llm-provider': LlmProviderSection,
  'source-control': SourceControlSection,
  'issue-tracker': IssueTrackerSection,
  plugins: PluginsSection,
  mcp: McpServersSection,
  paths: PathsSection,
}

interface SettingsLayoutProps {
  /** Optional callback when the user clicks "Run setup wizard" in the header. */
  onLaunchWizard?: () => void
}

export default function SettingsLayout({ onLaunchWizard }: SettingsLayoutProps) {
  const {
    loading,
    loadError,
    reload,
    draft,
    isDirty,
    dirtySections,
    discardChanges,
    save,
    saving,
    saveError,
    saveNotice,
    clearSaveFeedback,
    meta,
    claudeLogin,
    claudeLoginAccount,
  } = useSettings()

  const [activeSection, setActiveSection] = useState<SettingsSectionId>(() => {
    if (typeof window === 'undefined') return 'llm-provider'
    const hash = window.location.hash.replace(/^#/, '') as SettingsSectionId
    return SETTINGS_SECTIONS.some(section => section.id === hash) ? hash : 'llm-provider'
  })

  // Sync the URL hash so the back button + sharable links work.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.location.hash !== `#${activeSection}`) {
      window.history.replaceState(null, '', `#${activeSection}`)
    }
  }, [activeSection])

  const readiness = useMemo(
    () => evaluateReadiness({ draft, claudeLogin, claudeLoginAccount }),
    [draft, claudeLogin, claudeLoginAccount],
  )

  const groups: Record<'setup' | 'extensions' | 'advanced', typeof SETTINGS_SECTIONS> = {
    setup: SETTINGS_SECTIONS.filter(section => section.group === 'setup'),
    extensions: SETTINGS_SECTIONS.filter(section => section.group === 'extensions'),
    advanced: SETTINGS_SECTIONS.filter(section => section.group === 'advanced'),
  }

  if (loading) return <SettingsLoading />

  const ActiveSectionComponent = SECTION_COMPONENTS[activeSection]
  const activeDescriptor = getSectionDescriptor(activeSection)
  const activeReadiness = readiness.byId[activeSection]

  return (
    <div className="space-y-6 pb-32">
      <PageHeader
        title="Settings"
        description="Manage authentication, integrations, and runner internals."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {onLaunchWizard ? (
              <Button type="button" variant="outline" onClick={onLaunchWizard}>
                <Sparkles />
                Run setup wizard
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={() => void reload()}>
              <RefreshCcw />
              Reload
            </Button>
          </div>
        }
      />

      {loadError ? <ErrorState message={loadError} /> : null}

      {meta?.configError ? (
        <SettingsNotice tone="warning" title="Config file failed validation">
          The current config file failed schema validation. Save changes once to rewrite it cleanly.
        </SettingsNotice>
      ) : null}

      {!readiness.ready ? (
        <SettingsNotice tone="warning" title="Setup is not complete">
          Required sections still need attention before jobs can run:{' '}
          {readiness.missingRequired
            .map(id => getSectionDescriptor(id).label)
            .join(', ')}
          .
        </SettingsNotice>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          {(['setup', 'extensions', 'advanced'] as const).map(groupKey => {
            const items = groups[groupKey]
            if (items.length === 0) return null
            const groupMeta = GROUP_LABELS[groupKey]
            return (
              <div key={groupKey} className="space-y-2">
                <div className="px-2">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-fg-subtle">
                    {groupMeta.title}
                  </div>
                  <div className="mt-1 text-[11px] leading-4 text-fg-muted">{groupMeta.hint}</div>
                </div>
                <nav className="space-y-1" aria-label={`${groupMeta.title} sections`}>
                  {items.map(section => {
                    const isActive = section.id === activeSection
                    const sectionStatus = readiness.byId[section.id]
                    const Icon = section.icon
                    const hasUnsaved = dirtySections.has(section.id)
                    return (
                      <button
                        key={section.id}
                        type="button"
                        onClick={() => setActiveSection(section.id)}
                        className={cn(
                          'group flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors',
                          isActive
                            ? 'border-accent-500/35 bg-accent-500/8 text-fg'
                            : 'border-line/60 bg-overlay/40 text-fg-muted hover:border-line hover:text-fg',
                        )}
                      >
                        <Icon className={cn('size-4 shrink-0', isActive ? 'text-accent-300' : 'text-fg-subtle')} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium text-fg">{section.label}</span>
                            {hasUnsaved ? (
                              <span
                                className="inline-block size-1.5 shrink-0 rounded-full bg-accent-400"
                                aria-label="Unsaved changes"
                              />
                            ) : null}
                          </div>
                        </div>
                        <SectionMiniStatus status={sectionStatus.status} />
                      </button>
                    )
                  })}
                </nav>
              </div>
            )
          })}
        </aside>

        <main className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-fg-subtle">
                {GROUP_LABELS[activeDescriptor.group].title}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-xl font-semibold tracking-tight text-fg">{activeDescriptor.label}</h2>
                {activeDescriptor.required ? (
                  <span className="rounded-full border border-line bg-overlay/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-fg-subtle">
                    Required
                  </span>
                ) : null}
                <SettingsStatusBadge
                  status={activeReadiness.status}
                  label={activeReadiness.label}
                />
              </div>
              <p className="max-w-2xl text-sm leading-5 text-fg-muted">{activeDescriptor.description}</p>
            </div>
          </div>

          {saveError ? (
            <SettingsNotice tone="danger" title="Save failed">
              {saveError}
            </SettingsNotice>
          ) : null}
          {saveNotice ? <SettingsNotice tone="success">{saveNotice}</SettingsNotice> : null}

          <div className="space-y-6">
            <ActiveSectionComponent />
          </div>
        </main>
      </div>

      {/* Sticky save footer — only visible when there are pending changes. */}
      {isDirty ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-canvas/95 backdrop-blur supports-[backdrop-filter]:bg-canvas/85">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-4">
            <div className="flex items-center gap-3 text-sm text-fg-muted">
              <span className="inline-flex size-2 rounded-full bg-accent-400" />
              You have unsaved changes
              <span className="text-fg-subtle">·</span>
              <span className="text-fg">
                {dirtySections.size} section{dirtySections.size === 1 ? '' : 's'}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  discardChanges()
                  clearSaveFeedback()
                }}
                disabled={saving}
              >
                <RotateCcw />
                Discard changes
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void save()}
                disabled={saving}
              >
                {saving ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    Save all changes
                    <span className="ml-1 rounded-full border border-current/30 px-1.5 text-[10px] font-medium">
                      {dirtySections.size}
                    </span>
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function SectionMiniStatus({ status }: { status: SettingStatus }) {
  if (status === 'ok') return <CheckCircle2 className="size-4 shrink-0 text-success-300" aria-label="Ready" />
  if (status === 'warn') return <AlertTriangle className="size-4 shrink-0 text-warning-300" aria-label="Needs attention" />
  if (status === 'error') return <XCircle className="size-4 shrink-0 text-danger-300" aria-label="Failed" />
  if (status === 'pending') return <Loader2 className="size-4 shrink-0 animate-spin text-accent-300" aria-label="Working" />
  return null
}

function SettingsLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-9 w-40" />
      <Skeleton className="h-4 w-72" />
      <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        <Skeleton className="h-96 w-full" />
        <div className="space-y-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    </div>
  )
}
