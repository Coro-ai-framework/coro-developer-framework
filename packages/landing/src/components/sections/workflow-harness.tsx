import { agentPipeline, workflowCapabilities } from '../../content/landing'
import { Card } from '../ui/card'
import { Section } from '../ui/section'

export function WorkflowHarness() {
  return (
    <Section
      id="workflows"
      eyebrow="Deterministic workflow runs"
      title="Define the path once. Let agents execute it every time."
      description="Coro workflows declare phases, agents, subagents, checkpoints, tools, and skills. Teams can encode their own process while the runner follows the contract deterministically."
    >
      <Card className="overflow-hidden p-6 md:p-8">
        <div className="grid gap-4 lg:grid-cols-5">
          {agentPipeline.map((step, index) => (
            <div key={step.name} className="relative">
              {index < agentPipeline.length - 1 && (
                <div
                  className="absolute left-12 top-6 hidden h-px w-[calc(100%-1.5rem)] bg-gradient-to-r from-accent-400/50 to-transparent lg:block"
                  aria-hidden
                />
              )}
              <div className="relative rounded-2xl border border-line bg-canvas-deep/60 p-5">
                <div className="mb-5 inline-flex size-12 items-center justify-center rounded-2xl bg-white/[0.05] ring-1 ring-line">
                  <step.icon className="size-5 text-accent-300" />
                </div>
                <h3 className="text-lg font-semibold tracking-tight text-fg">{step.name}</h3>
                <p className="mt-3 text-sm leading-6 text-fg-muted">{step.role}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-8 rounded-2xl border border-line bg-white/[0.035] p-5">
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-fg-subtle">
            workflow as team-owned intelligence
          </p>
          <pre className="mt-4 overflow-x-auto font-mono text-sm leading-7 text-fg-muted">
            <code>{`phases:
  - planning: planner.md
  - coding: coder.md + code-reviewer
  - review: pr-reviewer.md
  - evaluation: evaluator.md`}</code>
          </pre>
        </div>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          {workflowCapabilities.map((item) => (
            <article
              key={item.title}
              className="rounded-2xl border border-line bg-canvas-deep/50 p-5"
            >
              <item.icon className="mb-4 size-5 text-accent-300" />
              <h3 className="text-base font-semibold tracking-tight text-fg">{item.title}</h3>
              <p className="mt-3 text-sm leading-6 text-fg-muted">{item.description}</p>
            </article>
          ))}
        </div>
      </Card>
    </Section>
  )
}
