import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const apiProxy = {
  target: 'http://localhost:3000',
  changeOrigin: true,
  bypass(req: { headers: Record<string, string | undefined> }) {
    // Let browser navigations (HTML requests) fall through to the SPA.
    // Only proxy fetch/XHR calls (Accept: application/json) and SSE (text/event-stream).
    const accept = req.headers['accept'] ?? ''
    if (accept.includes('text/html')) return req.url
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/jobs': apiProxy,
      '/health': apiProxy,
      '/webhook': apiProxy,
    },
  },
})
