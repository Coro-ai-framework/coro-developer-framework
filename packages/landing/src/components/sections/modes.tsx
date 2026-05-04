import { modes } from '../../content/landing'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { FeatureCard } from '../ui/card'
import { Section } from '../ui/section'

export function Modes() {
  return (
    <Section
      id="modes"
      eyebrow="Adoption path"
      title="Start local. Grow into a team AI operating system."
      description="Coro is designed to meet developers where they are: free solo execution first, then cloud-backed visibility, then collaborative team workflows."
    >
      <div className="grid gap-5 lg:grid-cols-3">
        {modes.map((mode) => (
          <FeatureCard
            key={mode.name}
            id={mode.name === 'Team' ? 'team-mode' : undefined}
            className={cn(
              'flex flex-col',
              mode.featured && 'border-accent-400/40 bg-accent-500/[0.08]',
            )}
          >
            <div className="mb-7">
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-accent-300">
                {mode.label}
              </p>
              <h3 className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-fg">
                {mode.name}
              </h3>
              <p className="mt-4 text-sm leading-7 text-fg-muted">{mode.description}</p>
            </div>
            <ul className="mb-8 space-y-3">
              {mode.highlights.map((highlight) => (
                <li key={highlight} className="flex items-center gap-3 text-sm text-fg-muted">
                  <span className="size-1.5 rounded-full bg-accent-300" />
                  {highlight}
                </li>
              ))}
            </ul>
            <Button
              href="#"
              variant={mode.featured ? 'primary' : 'secondary'}
              className="mt-auto"
            >
              {mode.cta}
            </Button>
          </FeatureCard>
        ))}
      </div>
    </Section>
  )
}
