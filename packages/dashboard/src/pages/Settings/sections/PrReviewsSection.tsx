import { useEffect, useRef, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card'
import { Input } from '../../../components/ui/input'
import { Switch } from '../../../components/ui/switch'
import { requestJson, jsonRequest } from '../../../lib/http'

interface ReviewsConfig {
  enabled?: boolean
  autonomy?: string
  approval?: string
  budgetUsdPerPr?: number
  budgetUsdPerDay?: number
  eventSource?: string
}

function saveMessage(savedConfig: ReviewsConfig & { running?: boolean }): string {
  if (savedConfig.enabled && savedConfig.running) return 'Saved. The inbox is polling review requests now.'
  if (savedConfig.enabled && savedConfig.running === false) return 'Saved and on, but this runner did not start the inbox. Restart it.'
  if (savedConfig.enabled) return 'Saved. Restart the runner so it starts watching review requests.'
  return 'Saved. Reviews are off, so the inbox is stopped.'
}

export default function PrReviewsSection() {
  const [config, setConfig] = useState<ReviewsConfig>({ enabled: false, autonomy: 'comment', approval: 'recommend' })
  const [saved, setSaved] = useState<string | null>(null)
  const edited = useRef(false)

  useEffect(() => {
    void requestJson<ReviewsConfig>('/reviews-settings').then(loaded => {
      if (!edited.current) setConfig(loaded)
    }).catch(() => undefined)
  }, [])

  async function persist(next: ReviewsConfig) {
    const savedConfig = await requestJson<ReviewsConfig & { running?: boolean }>('/reviews-settings', jsonRequest(next, { method: 'PUT' }))
    setSaved(saveMessage(savedConfig))
  }

  async function save() {
    edited.current = true
    try {
      await persist(config)
    } catch (err) {
      setSaved(err instanceof Error ? err.message : 'Could not save')
    }
  }

  function setEnabled(checked: boolean) {
    edited.current = true
    const next = { ...config, enabled: checked }
    setConfig(next)
    void persist(next).catch(err => {
      setSaved(err instanceof Error ? err.message : 'Could not save')
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>PR reviews</CardTitle>
        <CardDescription>
          Coro reviews pull requests you are asked to review. Comments post automatically. Approve and request-changes wait for you unless you choose otherwise. A repo cannot grant itself extra tools.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-center justify-between text-sm">
          Enabled
          <Switch checked={config.enabled === true} onCheckedChange={setEnabled} />
        </label>
        <label className="block text-sm">Autonomy
          <Input value={config.autonomy ?? 'comment'} onChange={e => setConfig({ ...config, autonomy: e.target.value })} />
        </label>
        <label className="block text-sm">Approval
          <Input value={config.approval ?? 'recommend'} onChange={e => setConfig({ ...config, approval: e.target.value })} />
        </label>
        <p className="text-xs text-muted-foreground">
          approval `auto` lets Coro approve as you. Leave it on `recommend` unless you want that.
        </p>
        <label className="block text-sm">Budget per PR (USD)
          <Input type="number" value={config.budgetUsdPerPr ?? 5} onChange={e => setConfig({ ...config, budgetUsdPerPr: Number(e.target.value) })} />
        </label>
        <label className="block text-sm">Budget per day (USD)
          <Input type="number" value={config.budgetUsdPerDay ?? 25} onChange={e => setConfig({ ...config, budgetUsdPerDay: Number(e.target.value) })} />
        </label>
        <label className="block text-sm">Event source
          <Input value={config.eventSource ?? 'poll'} onChange={e => setConfig({ ...config, eventSource: e.target.value })} />
        </label>
        <Button onClick={() => void save()}>Save</Button>
        {saved ? <p className="text-sm text-muted-foreground">{saved}</p> : null}
      </CardContent>
    </Card>
  )
}
