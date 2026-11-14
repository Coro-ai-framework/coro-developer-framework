import { useParams } from 'react-router-dom'
import RunView from '../components/run/run-view'

export default function JobDetail() {
  const { jobId } = useParams<{ jobId: string }>()
  if (!jobId) return null
  return <RunView key={jobId} jobId={jobId} variant="page" />
}
