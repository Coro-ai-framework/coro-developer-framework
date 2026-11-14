import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { PlanSessionProvider } from './providers/plan-session'
import { WorklistProvider } from './providers/worklist'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename="/dashboard">
      <WorklistProvider>
        <PlanSessionProvider>
          <App />
        </PlanSessionProvider>
      </WorklistProvider>
    </BrowserRouter>
  </StrictMode>,
)
