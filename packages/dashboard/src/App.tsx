import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import Layout from './components/Layout'
import JobList from './pages/JobList'
import JobDetail from './pages/JobDetail'
import NewRun from './pages/NewRun'
import Intelligence from './pages/Intelligence'
import Retrospective from './pages/Retrospective'
import Settings from './pages/Settings'
import { HOME_PATH, RUNS_LIST_PATH } from './lib/run-labels'

function RedirectToJobDetail() {
  const { jobId } = useParams<{ jobId: string }>()
  return <Navigate to={`${RUNS_LIST_PATH}/${jobId ?? ''}`} replace />
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<NewRun />} />
        <Route path={RUNS_LIST_PATH} element={<JobList />} />
        <Route path="/campaigns" element={<Navigate to={`${RUNS_LIST_PATH}?workflow=campaign`} replace />} />
        <Route path="/history" element={<Navigate to={`${RUNS_LIST_PATH}?status=terminal`} replace />} />
        <Route path="/jobs/new" element={<Navigate to={HOME_PATH} replace />} />
        <Route path="/jobs/:jobId" element={<JobDetail />} />
        <Route path="/campaigns/:jobId" element={<RedirectToJobDetail />} />
        <Route path="/intelligence" element={<Intelligence />} />
        <Route path="/retrospectives" element={<Retrospective />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  )
}
