import { Link, useLocation } from 'react-router-dom'
import { Outlet } from 'react-router-dom'

export default function Layout() {
  const location = useLocation()
  const isJobsActive = location.pathname === '/jobs'

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            <Link to="/" className="flex items-center gap-2.5 group">
              <div className="w-7 h-7 rounded-md bg-indigo-500 flex items-center justify-center text-white text-xs font-bold">
                A5
              </div>
              <span className="text-sm font-semibold text-zinc-200 group-hover:text-white transition-colors">
                Agent Dashboard
              </span>
            </Link>

            <nav className="flex items-center gap-1">
              <Link
                to="/jobs"
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  isJobsActive
                    ? 'bg-zinc-800 text-white'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                }`}
              >
                Jobs
              </Link>
            </nav>
          </div>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  )
}
