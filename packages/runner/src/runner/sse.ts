export function formatSseFrame(data: string, event?: string): string {
  const lines = data.split(/\r?\n/)
  const parts: string[] = []

  if (event) {
    parts.push(`event: ${event}`)
  }

  for (const line of lines) {
    parts.push(`data: ${line}`)
  }

  return `${parts.join('\n')}\n\n`
}