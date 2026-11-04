import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import PageHeader from '../components/common/page-header'
import ErrorState from '../components/common/error-state'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { requestJson, jsonRequest } from '../lib/http'

interface Finding {
  id: string
  severity: string
  status: string
  title: string
  path?: string
  lens: string
}

interface Round {
  round: number
  jobId: string
  kind: string
  outcome: string
  summary: string
  costUsd: number
}

interface ReviewDetail {
  id: string
  status: string
  pr: { title: string; url: string; author: string; headSha: string }
  ledger: { findings: Finding[] }
  rounds: Round[]
  pendingVerdict?: { verdict: string; body: string }
  totals: { costUsd: number }
}

export default function ReviewDetail() {
  const { id } = useParams<{ id: string }>()
  const [review, setReview] = useState<ReviewDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('open')

  async function load() {
    try {
      setReview(await requestJson<ReviewDetail>(`/reviews/${id}`))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load review')
    }
  }

  useEffect(() => { void load() }, [id])

  if (error) return <ErrorState title="Could not load review" message={error} />
  if (!review) return null
  const findings = review.ledger.findings.filter(finding => filter === 'all' || finding.status === filter)

  return (
    <div className="space-y-6">
      <PageHeader title={review.pr.title || 'Review'} description={`${review.pr.author} · ${review.status} · $${review.totals.costUsd.toFixed(2)}`} />
      {review.pr.url ? <a className="text-sm underline" href={review.pr.url}>{review.pr.url}</a> : null}
      {review.pendingVerdict ? (
        <Card>
          <CardHeader><CardTitle>Coro recommends: {review.pendingVerdict.verdict.replace('_', ' ')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="whitespace-pre-wrap text-sm">{review.pendingVerdict.body}</p>
            <div className="flex gap-2">
              <Button onClick={() => void requestJson(`/reviews/${id}/verdict`, jsonRequest({ action: 'submit' }, { method: 'POST' })).then(load)}>Submit</Button>
              <Button variant="outline" onClick={() => void requestJson(`/reviews/${id}/verdict`, jsonRequest({ action: 'discard' }, { method: 'POST' })).then(load)}>Discard</Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Findings</CardTitle>
          <div className="flex gap-2">
            {['open', 'addressed', 'declined', 'all'].map(value => (
              <Button key={value} size="sm" variant={filter === value ? 'primary' : 'outline'} onClick={() => setFilter(value)}>{value}</Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {findings.map(finding => (
            <div key={finding.id} className="flex items-center justify-between text-sm">
              <span>{finding.title}{finding.path ? ` · ${finding.path}` : ''}</span>
              <Badge variant="neutral">{finding.severity} · {finding.lens}</Badge>
            </div>
          ))}
          {findings.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Rounds</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {review.rounds.map(round => (
            <div key={`${round.round}-${round.jobId}`}>
              <div className="text-sm font-medium">#{round.round} {round.kind} · {round.outcome} · ${round.costUsd.toFixed(2)}</div>
              <p className="text-sm text-muted-foreground">{round.summary || 'No summary yet.'}</p>
              {round.jobId ? <a className="text-xs underline" href={`/jobs/${round.jobId}`}>Log</a> : null}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
