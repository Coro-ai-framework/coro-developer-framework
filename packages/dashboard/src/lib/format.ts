const relativeTimeFormatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

const compactNumberFormatter = new Intl.NumberFormat('en', {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1,
})

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatRelativeTime(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input)
  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000)
  const ranges = [
    { limit: 60, unit: 'second' as const, divisor: 1 },
    { limit: 3_600, unit: 'minute' as const, divisor: 60 },
    { limit: 86_400, unit: 'hour' as const, divisor: 3_600 },
    { limit: 604_800, unit: 'day' as const, divisor: 86_400 },
    { limit: 2_629_800, unit: 'week' as const, divisor: 604_800 },
    { limit: 31_557_600, unit: 'month' as const, divisor: 2_629_800 },
  ]

  const absoluteSeconds = Math.abs(diffSeconds)
  for (const range of ranges) {
    if (absoluteSeconds < range.limit) {
      return relativeTimeFormatter.format(Math.round(diffSeconds / range.divisor), range.unit)
    }
  }

  return relativeTimeFormatter.format(Math.round(diffSeconds / 31_557_600), 'year')
}

export function formatTokens(value: number): string {
  if (value === 0) return '0'
  if (value < 1_000) return value.toLocaleString('en-US')
  return compactNumberFormatter.format(value)
}

export function formatCompactNumber(value: number): string {
  return compactNumberFormatter.format(value)
}

export function formatCurrency(value: number | null | undefined, minimumFractionDigits = 2): string {
  if (value === null || value === undefined) return '—'

  if (Math.abs(value) > 0 && Math.abs(value) < 0.01) {
    return `$${value.toFixed(4)}`
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits,
    maximumFractionDigits: minimumFractionDigits,
  }).format(value)
}

export function formatPreciseCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`
  return currencyFormatter.format(value)
}

export function formatDuration(milliseconds: number | null | undefined): string {
  if (!milliseconds) return '—'

  const totalSeconds = Math.floor(milliseconds / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function formatTimestamp(value: string | number | Date, options?: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value)
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    month: 'short',
    day: '2-digit',
    ...options,
  }).format(date)
}

export function formatDateTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}