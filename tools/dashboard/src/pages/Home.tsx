import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'

export default function Home() {
  const [jobId, setJobId] = useState('')
  const navigate = useNavigate()

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = jobId.trim()
    if (trimmed) navigate(`/jobs/${trimmed}`)
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-56px)] px-4">
      <div className="w-full max-w-lg text-center">
        <div className="w-12 h-12 rounded-xl bg-indigo-500 flex items-center justify-center text-white text-lg font-bold mx-auto mb-5">
          A5
        </div>
        <h1 className="text-2xl font-semibold text-white mb-1">Agent Job Viewer</h1>
        <p className="text-sm text-zinc-400 mb-8">
          Enter a job ID to view its live streaming logs.
        </p>

        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="text"
            value={jobId}
            onChange={e => setJobId(e.target.value)}
            placeholder="e.g. my-service-job-1712345678"
            autoFocus
            className="flex-1 px-4 py-2.5 rounded-lg bg-zinc-900 border border-zinc-700 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors font-mono"
          />
          <button
            type="submit"
            disabled={!jobId.trim()}
            className="px-5 py-2.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            View Logs
          </button>
        </form>
      </div>
    </div>
  )
}
