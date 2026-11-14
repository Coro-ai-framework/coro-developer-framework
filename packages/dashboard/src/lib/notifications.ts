export const NOTIFICATIONS_STORAGE_KEY = 'coro.notifications.enabled'

/** The desktop shell needs no permission; a browser asks once. */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (typeof window !== 'undefined' && window.coroDesktop) return true
  if (typeof Notification === 'undefined') return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  return (await Notification.requestPermission()) === 'granted'
}

export function notificationsBlocked(): boolean {
  if (typeof window !== 'undefined' && window.coroDesktop) return false
  return typeof Notification === 'undefined' || Notification.permission === 'denied'
}
