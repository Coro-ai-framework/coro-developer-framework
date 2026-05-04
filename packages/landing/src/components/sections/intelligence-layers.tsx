import { intelligenceLayers } from '../../content/landing'
import { Card } from '../ui/card'
import { Section } from '../ui/section'

export function IntelligenceLayers() {
  return (
    <Section
      id="intelligence"
      eyebrow="Layered intelligence"
      title="Shared intelligence that adapts to the team."
      description="Coro separates reusable product intelligence from team knowledge, guided lessons, and repository-specific behavior, so every run can improve the next one without turning customization into a fork."
    >
      <div className="grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
        <Card className="p-6 md:p-8">
          <div className="space-y-4">
            {intelligenceLayers.map((layer, index) => (
              <div
                key={layer.name}
                className="rounded-2xl border border-line bg-white/[0.035] p-5"
              >
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h3 className="text-xl font-semibold text-fg">{layer.name}</h3>
                    <p className="mt-1 font-mono text-xs text-accent-300">{layer.label}</p>
                  </div>
                  <span className="text-sm text-fg-subtle">0{index + 1}</span>
                </div>
                <p className="mt-4 text-sm leading-7 text-fg-muted">{layer.description}</p>
              </div>
            ))}
          </div>
        </Card>
        <Card className="relative overflow-hidden p-6 md:p-8">
          <div className="absolute -right-20 -top-20 size-64 rounded-full bg-cyan-400/10 blur-3xl" />
          <div className="relative">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent-300">
              Team transformation
            </p>
            <h3 className="mt-5 max-w-xl text-3xl font-semibold tracking-[-0.04em] text-fg">
              Your best practices become the default path, then keep improving.
            </h3>
            <p className="mt-5 max-w-2xl text-base leading-8 text-fg-muted">
              Instead of teaching each agent from scratch, teams can capture conventions,
              workflows, review patterns, cost learnings, and repository facts in a durable
              intelligence layer. The result is a harness that gets more aligned as your team
              guides it.
            </p>
            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              {['Shared', 'Reviewable', 'Cost-aware', 'Repo-aware'].map((item) => (
                <div
                  key={item}
                  className="rounded-2xl border border-line bg-canvas-deep/60 px-4 py-3 text-sm font-medium text-fg-muted"
                >
                  {item}
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>
    </Section>
  )
}
