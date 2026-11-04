import { useState } from 'react'
import { GitPullRequestArrow } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import ErrorState from '../common/error-state'
import { startReview, type PrReview } from '../../lib/reviews'

interface StartReviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onStarted: (review: PrReview) => void
}

export default function StartReviewDialog({ open, onOpenChange, onStarted }: StartReviewDialogProps) {
  const [prUrl, setPrUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  async function submit() {
    const url = prUrl.trim()
    if (!url) {
      setError('Paste a pull request URL first.')
      return
    }
    setStarting(true)
    setError(null)
    try {
      const review = await startReview(url)
      setPrUrl('')
      onStarted(review)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the review')
    } finally {
      setStarting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) setError(null)
        onOpenChange(next)
      }}
    >
      <DialogContent className="w-[min(560px,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>Review a pull request</DialogTitle>
          <DialogDescription>
            Coro reads the pull request through your SCM connection and starts a round right away. It never runs the
            pull request's code and never merges it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <form
            className="space-y-3"
            onSubmit={event => {
              event.preventDefault()
              void submit()
            }}
          >
            <label className="block space-y-1.5 text-sm">
              <span className="text-fg-muted">Pull request</span>
              <Input
                autoFocus
                value={prUrl}
                onChange={event => setPrUrl(event.target.value)}
                placeholder="https://github.com/org/repo/pull/123 or org/repo#123"
              />
            </label>
            {error ? <ErrorState title="The review did not start" message={error} /> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={starting}>
                <GitPullRequestArrow />
                {starting ? 'Starting…' : 'Start review'}
              </Button>
            </div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
