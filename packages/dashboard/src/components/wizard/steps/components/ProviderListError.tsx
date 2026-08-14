import SettingsNotice from '../../../settings/SettingsNotice'
import { Button } from '../../../ui/button'

interface ProviderListErrorProps {
  message: string
  onRetry: () => void
}

/**
 * Shown when the provider catalog can't be fetched. Without it the step
 * renders an empty list, which reads as "Coro supports nothing" rather than
 * "the runner is unreachable".
 */
export default function ProviderListError({ message, onRetry }: ProviderListErrorProps) {
  return (
    <SettingsNotice tone="danger" title="Could not load providers">
      <p>{message}</p>
      <p className="pt-1">
        The runner may still be starting up, or it stopped while this page was open.
      </p>
      <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
        Try again
      </Button>
    </SettingsNotice>
  )
}
