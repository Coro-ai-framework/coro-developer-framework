import { useState } from 'react'
import SettingsLayout from './SettingsLayout'
import { SettingsProvider } from './SettingsContext'
import SetupWizard from '../../components/wizard/SetupWizard'

/**
 * Entry point for the Settings route. Wraps the layout in the
 * SettingsProvider so every section shares the same dirty-tracked
 * draft + Claude login state.
 */
export default function Settings() {
  const [wizardOpen, setWizardOpen] = useState(false)

  return (
    <SettingsProvider>
      <SettingsLayout onLaunchWizard={() => setWizardOpen(true)} />
      <SetupWizard open={wizardOpen} onOpenChange={setWizardOpen} />
    </SettingsProvider>
  )
}
