import { pageIcons } from '../../content/landing'
import { Button } from '../ui/button'
import { Card } from '../ui/card'

const ArrowRight = pageIcons.arrowRight

export function FinalCta() {
  return (
    <section id="docs" className="mx-auto max-w-7xl px-6 py-20 sm:px-8">
      <Card className="relative overflow-hidden p-8 text-center md:p-14">
        <div className="absolute inset-x-20 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400 to-transparent" />
        <div className="absolute left-1/2 top-0 size-80 -translate-x-1/2 rounded-full bg-accent-500/20 blur-3xl" />
        <div className="relative mx-auto max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.32em] text-accent-300">
            Build the operating layer
          </p>
          <h2 className="mt-5 text-4xl font-semibold tracking-[-0.05em] text-fg sm:text-6xl">
            Start with one local run. Grow into team-wide AI execution.
          </h2>
          <p className="mt-6 text-lg leading-8 text-fg-muted">
            Encode your workflow once, run it repeatedly, and let your team’s intelligence
            improve under review with shared visibility into progress and cost.
          </p>
          <div className="mt-9 flex flex-col justify-center gap-4 sm:flex-row">
            <Button href="#modes" size="lg">
              Start Solo Free
              <ArrowRight className="size-4" />
            </Button>
            <Button href="#docs" variant="secondary" size="lg">
              Read the docs
            </Button>
          </div>
        </div>
      </Card>
    </section>
  )
}
