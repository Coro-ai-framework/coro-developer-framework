import net from 'node:net'

import {
  DESKTOP_RUNNER_DEFAULT_HOST,
  DESKTOP_RUNNER_DEFAULT_PREFERRED_PORT,
  assertValidDesktopPort,
} from './contract'

export interface DesktopPortSelectionOptions {
  host?: string
  preferredPort?: number
}

export interface DesktopPortSelection {
  port: number
  host: string
  source: 'preferred' | 'ephemeral'
}

export async function chooseDesktopRunnerPort(
  options: DesktopPortSelectionOptions = {},
): Promise<DesktopPortSelection> {
  const host = options.host ?? DESKTOP_RUNNER_DEFAULT_HOST
  const preferredPort = options.preferredPort ?? DESKTOP_RUNNER_DEFAULT_PREFERRED_PORT
  assertValidDesktopPort(preferredPort)

  if (await isLoopbackPortAvailable(preferredPort, host)) {
    return {
      port: preferredPort,
      host,
      source: 'preferred',
    }
  }

  return {
    port: await allocateEphemeralLoopbackPort(host),
    host,
    source: 'ephemeral',
  }
}

export async function isLoopbackPortAvailable(port: number, host = DESKTOP_RUNNER_DEFAULT_HOST): Promise<boolean> {
  assertValidDesktopPort(port)

  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()

    server.once('error', () => {
      resolve(false)
    })

    server.listen(port, host, () => {
      server.close((err) => {
        resolve(!err)
      })
    })
  })
}

async function allocateEphemeralLoopbackPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)

    server.listen(0, host, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => {
          reject(new Error('Could not determine an ephemeral desktop runner port'))
        })
        return
      }

      const { port } = address
      server.close((err) => {
        if (err) {
          reject(err)
          return
        }
        resolve(port)
      })
    })
  })
}