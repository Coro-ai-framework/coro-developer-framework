import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import Layout from './components/Layout'
import Home from './pages/Home'
import History from './pages/History'
import JobList from './pages/JobList'
import JobDetail from './pages/JobDetail'
import CreateJob from './pages/CreateJob'
import Settings from './pages/Settings'

function RedirectToJobDetail() {
  const { jobId } = useParams<{ jobId: string }>()
  return <Navigate to={`/jobs/${jobId ?? ''}`} replace />
}

// Legacy /campaigns paths are preserved as deep-link aliases. Lists redirect
// into the unified Runs view with a workflow filter; detail pages redirect
// to the canonical /jobs/:id detail surface.
export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/jobs" element={<JobList />} />
        <Route path="/campaigns" element={<Navigate to="/jobs?workflow=campaign" replace />} />
        <Route path="/history" element={<History />} />
        <Route path="/jobs/new" element={<CreateJob />} />
        <Route path="/jobs/:jobId" element={<JobDetail />} />
        <Route path="/campaigns/:jobId" element={<RedirectToJobDetail />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  )
}
