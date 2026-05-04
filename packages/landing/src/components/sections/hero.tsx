import { hero, pageIcons } from '../../content/landing'
import { Button } from '../ui/button'
import { Card } from '../ui/card'

const ArrowRight = pageIcons.arrowRight
const Orbit = pageIcons.orbit

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="bg-grid absolute inset-0" aria-hidden />
      <div className="absolute left-1/2 top-20 size-[34rem] -translate-x-1/2 rounded-full bg-accent-500/20 blur-3xl" />
      <div className="relative mx-auto grid max-w-7xl items-center gap-14 px-6 py-20 sm:px-8 lg:grid-cols-[1.05fr_0.95fr] lg:py-28">
        <div>
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-line bg-white/[0.04] px-4 py-2 text-sm text-fg-muted backdrop-blur">
            <Orbit className="size-4 text-accent-300" />
            {hero.eyebrow}
          </div>
          <h1 className="max-w-4xl text-5xl font-semibold tracking-[-0.07em] text-fg sm:text-7xl lg:text-8xl">
            <span className="text-gradient">{hero.headline}</span>
          </h1>
          <p className="mt-7 max-w-2xl text-lg leading-8 text-fg-muted sm:text-xl">
            {hero.description}
          </p>
          <div className="mt-9 flex flex-col gap-4 sm:flex-row">
            <Button href={hero.primaryCta.href} size="lg">
              {hero.primaryCta.label}
              <ArrowRight className="size-4" />
            </Button>
            <Button href={hero.secondaryCta.href} variant="secondary" size="lg">
              {hero.secondaryCta.label}
            </Button>
          </div>
          <div className="mt-8 flex flex-wrap gap-3">
            {hero.proofPoints.map((point) => (
              <span
                key={point}
                className="rounded-full border border-line bg-white/[0.035] px-3 py-1.5 text-xs font-medium text-fg-muted"
              >
                {point}
              </span>
            ))}
          </div>
        </div>

        <HeroConsole />
      </div>
    </section>
  )
}

function HeroConsole() {
  const rows = [
    ['workflow.md', 'planning -> coding -> review -> evaluation'],
    ['agents/', 'planner + coder + reviewer + evaluator'],
    ['memory/', 'human-approved self-improvement'],
    ['run', hero.command],
  ]

  return (
    <Card className="relative overflow-hidden p-5">
      <div className="absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-accent-300 to-transparent" />
      <div className="flex items-center justify-between border-b border-line pb-4">
        <div className="flex items-center gap-2">
          <span className="size-3 rounded-full bg-danger-400/80" />
          <span className="size-3 rounded-full bg-warning-500/80" />
          <span className="size-3 rounded-full bg-success-500/80" />
        </div>
        <span className="font-mono text-xs text-fg-subtle">coro harness</span>
      </div>

      <div className="mt-5 space-y-3 font-mono text-sm">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="grid gap-2 rounded-2xl border border-line bg-canvas-deep/70 p-4 sm:grid-cols-[9rem_1fr]"
          >
            <span className="text-accent-300">{label}</span>
            <span className="text-fg-muted">{value}</span>
          </div>
        ))}
      </div>

      <div className="mt-5 rounded-2xl border border-accent-400/20 bg-accent-500/10 p-4">
        <div className="mb-3 text-xs uppercase tracking-[0.24em] text-accent-300">
          deterministic path
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          {['Plan', 'Code', 'Review', 'Merge', 'Evaluate'].map((step, index) => (
            <span key={step} className="inline-flex items-center gap-2">
              <span className="rounded-full bg-white/[0.06] px-3 py-1 text-fg">{step}</span>
              {index < 4 && <ArrowRight className="size-4 text-fg-subtle" />}
            </span>
          ))}
        </div>
      </div>
    </Card>
  )
}
