import http from 'http'
import https from 'https'

/**
 * Lightweight SSE (Server-Sent Events) client.
 *
 * Connects to the Agent Host's /jobs/:id/stream endpoint and emits
 * log lines to a callback. Handles reconnection, heartbeats, and
 * graceful shutdown.
 */
export interface SseOptions {
  url: string
  onMessage: (data: string) => void
  onError?: (err: Error) => void
  onClose?: () => void
}

export function connectSse(opts: SseOptions): { close: () => void } {
  const parsedUrl = new URL(opts.url)
  const transport = parsedUrl.protocol === 'https:' ? https : http

  let closed = false
  let req: http.ClientRequest | null = null

  function connect() {
    if (closed) return

    req = transport.get(
      opts.url,
      { headers: { Accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let body = ''
          res.on('data', (chunk: Buffer) => { body += chunk.toString() })
          res.on('end', () => {
            opts.onError?.(new Error(`HTTP ${res.statusCode}: ${body}`))
          })
          return
        }

        let buffer = ''

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              opts.onMessage(line.slice(6))
            }
            // Ignore heartbeat comments (": heartbeat") and empty lines
          }
        })

        res.on('end', () => {
          if (!closed) {
            opts.onClose?.()
          }
        })

        res.on('error', (err: Error) => {
          if (!closed) opts.onError?.(err)
        })
      },
    )

    req.on('error', (err: Error) => {
      if (!closed) opts.onError?.(err)
    })
  }

  connect()

  return {
    close: () => {
      closed = true
      req?.destroy()
    },
  }
}
