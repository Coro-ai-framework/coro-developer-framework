import { Bot, GitBranch, KanbanSquare, Sparkles } from 'lucide-react'

/**
 * Marketing-style intro to the FTUE flow. Sets expectations:
 *   - This will take about a minute.
 *   - Three things will be configured (one of them optional).
 *   - You can skip a step and finish later in Settings.
 *
 * Visually distinct from the other (configuration) steps to signal
 * "this is just a primer, not work to do".
 */
export default function WelcomeStep() {
  const previews = [
    {
      icon: Bot,
      title: 'Connect a model',
      copy: 'Claude or OpenAI — Coro uses it to plan, code, and review.',
    },
    {
      icon: GitBranch,
      title: 'Connect your code host',
      copy: 'GitHub or Bitbucket. Coro clones, branches, and opens PRs.',
    },
    {
      icon: KanbanSquare,
      title: 'Optional: a tracker',
      copy: 'Jira, Linear, or GitHub Issues — Coro reports back as work moves.',
    },
  ]

  return (
    <div className="relative isolate overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_60%_45%_at_50%_-10%,rgba(97,114,255,0.22),transparent_70%),radial-gradient(ellipse_50%_40%_at_85%_110%,rgba(56,189,248,0.16),transparent_75%),radial-gradient(ellipse_40%_35%_at_15%_115%,rgba(168,85,247,0.14),transparent_75%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.07] [background-image:linear-gradient(to_right,rgba(255,255,255,0.6)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.6)_1px,transparent_1px)] [background-size:36px_36px] [mask-image:radial-gradient(ellipse_at_center,black_40%,transparent_75%)]"
      />

      <div className="flex flex-col items-center gap-5 px-6 py-8 text-center sm:gap-6 sm:px-10 sm:py-10">
        <div className="relative flex size-24 items-center justify-center">
          <span className="absolute inset-0 rounded-full bg-accent-500/20 blur-2xl" />
          <span className="relative inline-flex size-24 items-center justify-center rounded-3xl bg-gradient-to-br from-accent-500/25 via-accent-500/10 to-transparent ring-1 ring-accent-500/35 shadow-[0_0_60px_-20px_rgba(97,114,255,0.6)]">
            <svg viewBox="0 0 24 24" fill="none" className="size-12 text-accent-200 drop-shadow-[0_0_12px_rgba(125,150,255,0.55)]">
              <path
                d="M19 7.5A8 8 0 1 0 19 16.5"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
              <circle cx="18.25" cy="12" r="1.6" fill="currentColor" />
            </svg>
          </span>
        </div>

        <div className="space-y-3">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-accent-500/30 bg-accent-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-accent-200">
            <Sparkles className="size-3.5" />
            First-time setup
          </div>
          <h1 className="text-balance bg-gradient-to-b from-fg via-fg to-fg-muted bg-clip-text text-4xl font-semibold tracking-tight text-transparent sm:text-5xl">
            Welcome to Coro
          </h1>
          <p className="mx-auto max-w-xl text-pretty text-sm text-fg-muted sm:text-base">
            Coro runs autonomous coding agents that plan, write, review, and merge code on your behalf. Spend the next minute wiring up a model and a code host — we'll show you what each step is for.
          </p>
          <p className="mx-auto max-w-xl text-pretty text-xs text-fg-subtle sm:text-sm">
            Anything you skip can be configured later from <strong className="text-fg-muted">Settings → Setup</strong>.
          </p>
        </div>

        <div className="grid w-full max-w-2xl gap-3 sm:grid-cols-3">
          {previews.map(({ icon: Icon, title, copy }) => (
            <div
              key={title}
              className="group relative overflow-hidden rounded-2xl border border-line bg-overlay/40 p-4 text-left transition-colors hover:border-accent-500/30 hover:bg-overlay/60"
            >
              <div
                aria-hidden
                className="pointer-events-none absolute -right-6 -top-6 size-20 rounded-full bg-accent-500/10 blur-2xl transition-opacity group-hover:opacity-100"
              />
              <span className="relative inline-flex size-9 items-center justify-center rounded-xl bg-accent-500/12 ring-1 ring-accent-500/25 text-accent-200">
                <Icon className="size-4" />
              </span>
              <div className="relative mt-3 text-sm font-medium text-fg">{title}</div>
              <div className="relative mt-1 text-xs leading-relaxed text-fg-muted">{copy}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
