import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLocalStorage } from '../../hooks/use-local-storage'
import { diffAttention, type AttentionEvent } from '../../lib/attention'
import { NOTIFICATIONS_STORAGE_KEY } from '../../lib/notifications'
import type { Worklist } from '../../lib/worklist'
import { useWorklist } from '../../providers/worklist'

/**
 * Keeps the desktop badge in step with "Needs you", and raises a notification
 * when something arrives while Coro is in the background. Renders nothing.
 */
export default function AttentionNotifier() {
  const { worklist, loading } = useWorklist()
  const navigate = useNavigate()
  const [enabled] = useLocalStorage(NOTIFICATIONS_STORAGE_KEY, true)
  const previous = useRef<Worklist | null>(null)

  useEffect(() => {
    window.coroDesktop?.setAttentionCount(worklist.needsYou)
  }, [worklist.needsYou])

  useEffect(() => window.coroDesktop?.onNavigate(path => navigate(path)), [navigate])

  useEffect(() => {
    if (loading) return
    const events = diffAttention(previous.current, worklist)
    previous.current = worklist
    if (!enabled || events.length === 0) return
    // While Coro has focus the work list itself is the signal.
    if (document.hasFocus() && !document.hidden) return
    for (const event of events) show(event, path => navigate(path))
  }, [enabled, loading, navigate, worklist])

  return null
}

function show(event: AttentionEvent, open: (path: string) => void) {
  if (window.coroDesktop) {
    window.coroDesktop.notify({ title: event.title, body: event.body, path: event.path })
    return
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const notification = new Notification(event.title, { body: event.body, tag: event.key })
  notification.onclick = () => {
    window.focus()
    open(event.path)
    notification.close()
  }
}
