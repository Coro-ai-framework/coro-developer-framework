import { defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { IncomingMessage } from 'http'

const apiProxy: ProxyOptions = {
  target: 'http://localhost:3000',
  changeOrigin: true,
  bypass(req: IncomingMessage) {
    const accept = req.headers['accept'] ?? ''
    if (typeof accept === 'string' && accept.includes('text/html')) {
      return req.url
    }
  },
}

export default defineConfig({
  base: '/dashboard/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/jobs': apiProxy,
      '/health': apiProxy,
      '/webhook': apiProxy,
      '/config': apiProxy,
      '/retrospectives': apiProxy,
      '/intake': apiProxy,
    },
  },
})
