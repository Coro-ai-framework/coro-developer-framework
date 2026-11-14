import { useState } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import Layout from './components/Layout'
import { PageFrame, WorkspaceFrame } from './components/layout/frames'
import JobList from './pages/JobList'
import JobDetail from './pages/JobDetail'
import Workspace from './pages/Workspace'
import Intelligence from './pages/Intelligence'
import Retrospective from './pages/Retrospective'
import Reviews from './pages/Reviews'
import ReviewDetail from './pages/ReviewDetail'
import Settings from './pages/Settings'
import { HOME_PATH, RUNS_LIST_PATH } from './lib/run-labels'
import { conversationPath } from './lib/worklist'
import { mintConversationId } from './providers/plan-session'

function RedirectToJobDetail() {
  const { jobId } = useParams<{ jobId: string }>()
  return <Navigate to={`${RUNS_LIST_PATH}/${jobId ?? ''}`} replace />
}

/** `/` is always a fresh conversation; the work list is how you go back to one. */
function NewConversation() {
  const [id] = useState(mintConversationId)
  return <Navigate to={conversationPath(id)} replace />
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route element={<WorkspaceFrame />}>
          <Route index element={<NewConversation />} />
          <Route path="/plans/:conversationId" element={<Workspace />} />
        </Route>
        <Route element={<PageFrame />}>
          <Route path={RUNS_LIST_PATH} element={<JobList />} />
          <Route path="/campaigns" element={<Navigate to={`${RUNS_LIST_PATH}?workflow=campaign`} replace />} />
          <Route path="/history" element={<Navigate to={`${RUNS_LIST_PATH}?status=terminal`} replace />} />
          <Route path="/jobs/new" element={<Navigate to={HOME_PATH} replace />} />
          <Route path="/jobs/:jobId" element={<JobDetail />} />
          <Route path="/campaigns/:jobId" element={<RedirectToJobDetail />} />
          <Route path="/intelligence" element={<Intelligence />} />
          <Route path="/retrospectives" element={<Retrospective />} />
          <Route path="/reviews" element={<Reviews />} />
          <Route path="/reviews/:id" element={<ReviewDetail />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to={HOME_PATH} replace />} />
        </Route>
      </Route>
    </Routes>
  )
}
