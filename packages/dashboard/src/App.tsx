import { Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Home from './pages/Home'
import History from './pages/History'
import JobList from './pages/JobList'
import JobDetail from './pages/JobDetail'
import CreateJob from './pages/CreateJob'
import Settings from './pages/Settings'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/jobs" element={<JobList />} />
        <Route path="/campaigns" element={<JobList />} />
        <Route path="/history" element={<History />} />
        <Route path="/jobs/new" element={<CreateJob />} />
        <Route path="/jobs/:jobId" element={<JobDetail />} />
        <Route path="/campaigns/:jobId" element={<JobDetail />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  )
}
