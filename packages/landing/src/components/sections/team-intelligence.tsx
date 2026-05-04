import { teamIntelligence } from '../../content/landing'
import { FeatureCard } from '../ui/card'
import { Section } from '../ui/section'

export function TeamIntelligence() {
  return (
    <Section
      eyebrow="Guided learning loop"
      title="Every implementation teaches the harness how your team works."
      description="Coro is designed to capture the useful parts of each run: what it cost, what reviewers corrected, what conventions mattered, and what should become shared intelligence for the next feature."
    >
      <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
        {teamIntelligence.map((item) => (
          <FeatureCard key={item.title} className="flex flex-col">
            <div className="mb-5 inline-flex size-11 items-center justify-center rounded-2xl bg-accent-500/12 ring-1 ring-accent-400/20">
              <item.icon className="size-5 text-accent-300" />
            </div>
            <h3 className="text-lg font-semibold tracking-tight text-fg">{item.title}</h3>
            <p className="mt-3 text-sm leading-7 text-fg-muted">{item.description}</p>
          </FeatureCard>
        ))}
      </div>
    </Section>
  )
}
