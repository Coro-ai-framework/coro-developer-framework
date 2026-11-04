import { useEffect, useState } from 'react'
import { GitPullRequest } from 'lucide-react'
import { Link } from 'react-router-dom'
import PageHeader from '../components/common/page-header'
import EmptyState from '../components/common/empty-state'
import ErrorState from '../components/common/error-state'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { requestJson, jsonRequest } from '../lib/http'

interface ReviewRow {
  id: string
  status: string
  pr: { title: string; url: string; author: string }
  totals: { rounds: number; costUsd: number }
  pendingVerdict?: { verdict: string }
  updatedAt: string
}

const ORDER = ['awaiting-verdict', 'running', 'queued', 'idle', 'paused', 'failed', 'done']

export default function Reviews() {
  const [rows, setRows] = useState<ReviewRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [errorTitle, setErrorTitle] = useState('Review did not start')
  const [prUrl, setPrUrl] = useState('')
  const [starting, setStarting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  async function load() {
    try {
      setRows(await requestJson<ReviewRow[]>('/reviews'))
    } catch (err) {
      setErrorTitle('Could not load reviews')
      setError(err instanceof Error ? err.message : 'Could not load reviews')
    }
  }

  async function start() {
    const url = prUrl.trim()
    if (!url) {
      setError('Paste a pull request URL first.')
      return
    }
    setStarting(true)
    setNotice(null)
    setError(null)
    setErrorTitle('Review did not start')
    try {
      const created = await requestJson<{ id: string; status: string }>('/reviews', jsonRequest({ prUrl: url }, { method: 'POST' }))
      setPrUrl('')
      setNotice(`Review ${created.id} is ${created.status}. A round starts immediately.`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the review')
    } finally {
      setStarting(false)
    }
  }

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => clearInterval(timer)
  }, [])

  const sorted = [...rows].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))

  return (
    <div className="space-y-6">
      <PageHeader title="Reviews" description="Pull requests you were asked to review. Coro comments and recommends. It does not merge." />
      {error ? <ErrorState title={errorTitle} message={error} /> : null}
      {notice ? <p className="text-sm text-fg-muted">{notice}</p> : null}
      <Card>
        <CardHeader><CardTitle>Review a pull request</CardTitle></CardHeader>
        <CardContent className="flex gap-2">
          <Input value={prUrl} onChange={e => setPrUrl(e.target.value)} placeholder="https://github.com/org/repo/pull/1" onKeyDown={e => { if (e.key === 'Enter') void start() }} />
          <Button disabled={starting} onClick={() => void start()}>{starting ? 'Starting' : 'Start'}</Button>
        </CardContent>
      </Card>
      {sorted.length === 0 ? <EmptyState icon={GitPullRequest} title="No reviews yet" description="Turn reviews on in Settings, or paste a pull request URL." /> : null}
      <div className="space-y-2">
        {sorted.map(row => (
          <Link key={row.id} to={`/reviews/${row.id}`} className="block">
            <Card>
              <CardContent className="flex items-center justify-between py-4">
                <div>
                  <div className="font-medium">{row.pr.title || row.pr.url}</div>
                  <div className="text-sm text-muted-foreground">{row.pr.author} · {row.totals.rounds} rounds · ${row.totals.costUsd.toFixed(2)}</div>
                </div>
                <Badge variant={row.status === 'awaiting-verdict' ? 'warning' : 'neutral'}>
                  {row.pendingVerdict ? `Needs verdict: ${row.pendingVerdict.verdict}` : row.status}
                </Badge>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
