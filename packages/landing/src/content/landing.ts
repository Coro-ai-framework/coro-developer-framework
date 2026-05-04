import {
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  Code2,
  Coins,
  GitPullRequestArrow,
  Orbit,
  PanelsTopLeft,
  ShieldCheck,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  label: string
  href: string
}

export interface Cta {
  label: string
  href: string
}

export interface Feature {
  icon: LucideIcon
  title: string
  description: string
}

export interface Mode {
  name: string
  label: string
  description: string
  highlights: string[]
  cta: string
  featured?: boolean
}

export interface AgentStep {
  name: string
  role: string
  icon: LucideIcon
}

export interface WorkflowCapability {
  title: string
  description: string
  icon: LucideIcon
}

export const navigation: NavItem[] = [
  { label: 'Workflows', href: '#workflows' },
  { label: 'Intelligence', href: '#intelligence' },
  { label: 'Modes', href: '#modes' },
  { label: 'Docs', href: '#docs' },
]

export const hero = {
  eyebrow: 'Plug-and-play AI harness for SDLC',
  headline: 'Turn your engineering process into deterministic AI workflows.',
  description:
    'Coro transforms markdown into specialized AI engineers that plan, code, review, merge, evaluate, and learn from every guided run your team controls.',
  primaryCta: { label: 'Start Solo Free', href: '#modes' } satisfies Cta,
  secondaryCta: { label: 'Explore Team Mode', href: '#team-mode' } satisfies Cta,
  command: 'coro start',
  proofPoints: [
    'Markdown workflows',
    'Shared intelligence',
    'Cost visibility',
    'Solo -> Solo+ -> Team',
  ],
}

export const teamIntelligence: Feature[] = [
  {
    icon: BrainCircuit,
    title: 'Guided learning',
    description:
      'Every run can produce reviewable lessons, memory updates, and skill refinements so the system becomes more aligned with your team over time.',
  },
  {
    icon: Users,
    title: 'Shared team intelligence',
    description:
      'Conventions, repo facts, workflows, and operating preferences are captured once and reused across future work instead of rediscovered in every chat.',
  },
  {
    icon: Coins,
    title: 'Cost visibility by feature',
    description:
      'Track what each implementation costs across planning, coding, review, and evaluation so teams can understand the economics of agentic delivery.',
  },
  {
    icon: PanelsTopLeft,
    title: 'Shared dashboards',
    description:
      'Solo+ and Team modes add online progress tracking, shared run visibility, and management surfaces for accounts, teams, and workflows.',
  },
]

export const intelligenceLayers = [
  {
    name: 'Base Intelligence',
    label: '@coro/intelligence-base',
    description: 'Generic agents, workflows, skills, and memory templates shipped with Coro.',
  },
  {
    name: 'Team Intelligence',
    label: 'team overlay',
    description:
      'Shared process, conventions, service knowledge, guided lessons, and operating preferences.',
  },
  {
    name: 'Repo Intelligence',
    label: '.coro/',
    description: 'Per-codebase customizations that travel with each repository.',
  },
]

export const agentPipeline: AgentStep[] = [
  { name: 'Planner', role: 'Scopes work and creates ordered work items.', icon: PanelsTopLeft },
  { name: 'Coder', role: 'Implements, builds, tests, and prepares a PR.', icon: Code2 },
  { name: 'Reviewer', role: 'Critiques the diff before humans see it.', icon: ShieldCheck },
  { name: 'Gatekeeper', role: 'Coordinates human review and merge readiness.', icon: GitPullRequestArrow },
  { name: 'Evaluator', role: 'Verifies the merged result and captures lessons.', icon: CheckCircle2 },
]

export const workflowCapabilities: WorkflowCapability[] = [
  {
    title: 'Define your workflows',
    description:
      'Create phase-based workflows for how your team plans, codes, reviews, evaluates, or coordinates larger initiatives.',
    icon: Workflow,
  },
  {
    title: 'Drop in your skills',
    description:
      'Bring existing standards, testing practices, language conventions, and domain playbooks into reusable skill files.',
    icon: BrainCircuit,
  },
  {
    title: 'Shape your agents',
    description:
      'Create agents that fit your approval gates, repo rules, risk tolerance, and delivery requirements.',
    icon: Users,
  },
]

export const modes: Mode[] = [
  {
    name: 'Solo',
    label: 'Free standalone',
    description: 'Run Coro entirely on your laptop with the local dashboard and isolated workspace state.',
    highlights: ['Local runner', 'Local dashboard', 'SQLite state', 'Best for personal adoption'],
    cta: 'Start free',
  },
  {
    name: 'Solo+',
    label: 'One-person cloud tracking',
    description:
      'Keep the solo workflow, add online progress tracking, cost visibility, and portable run history.',
    highlights: [
      'Cloud-backed progress',
      'Feature-level cost visibility',
      'Personal run history',
      'Upgrade path to teams',
    ],
    cta: 'Join the list',
    featured: true,
  },
  {
    name: 'Team',
    label: 'Collaborative control plane',
    description:
      'Share dashboards, workflow visibility, tenant intelligence, guided learning, and event-driven coordination across a team.',
    highlights: [
      'Shared team dashboards',
      'Shared intelligence overlays',
      'Cost visibility by run',
      'Collaborative run management',
    ],
    cta: 'Explore teams',
  },
]

export const footerLinks = [
  {
    title: 'Product',
    links: [
      { label: 'Features', href: '#intelligence' },
      { label: 'Workflows', href: '#workflows' },
      { label: 'Modes', href: '#modes' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'Documentation', href: '#docs' },
      { label: 'Dashboard', href: '/dashboard/' },
      { label: 'GitHub', href: '#' },
    ],
  },
  {
    title: 'Account',
    links: [
      { label: 'Log in', href: '#' },
      { label: 'Create account', href: '#' },
      { label: 'Manage team', href: '#' },
    ],
  },
]

export const pageIcons = {
  arrowRight: ArrowRight,
  orbit: Orbit,
}
