import { useEffect, useState } from 'react'
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

export default function PrReviewsSection() {
  const [config, setConfig] = useState<ReviewsConfig>({ enabled: false, autonomy: 'comment', approval: 'recommend' })
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    void requestJson<ReviewsConfig>('/reviews-settings').then(setConfig).catch(() => undefined)
  }, [])

  async function save() {
    await requestJson('/reviews-settings', jsonRequest(config, { method: 'PUT' }))
    setSaved('Saved. Restart the runner so the pollers pick this up.')
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
          <Switch checked={config.enabled === true} onCheckedChange={checked => setConfig({ ...config, enabled: checked })} />
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
