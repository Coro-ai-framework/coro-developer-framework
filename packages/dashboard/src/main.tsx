import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { PlanSessionProvider } from './providers/plan-session'
import { WorkspaceTabsProvider } from './providers/workspace-tabs'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename="/dashboard">
      <PlanSessionProvider>
        <WorkspaceTabsProvider>
          <App />
        </WorkspaceTabsProvider>
      </PlanSessionProvider>
    </BrowserRouter>
  </StrictMode>,
)
