import { Footer } from './components/layout/footer'
import { Navbar } from './components/layout/navbar'
import { FinalCta } from './components/sections/final-cta'
import { Hero } from './components/sections/hero'
import { IntelligenceLayers } from './components/sections/intelligence-layers'
import { Modes } from './components/sections/modes'
import { TeamIntelligence } from './components/sections/team-intelligence'
import { WorkflowHarness } from './components/sections/workflow-harness'

export default function App() {
  return (
    <div className="min-h-screen">
      <Navbar />
      <main>
        <Hero />
        <WorkflowHarness />
        <IntelligenceLayers />
        <TeamIntelligence />
        <Modes />
        <FinalCta />
      </main>
      <Footer />
    </div>
  )
}
