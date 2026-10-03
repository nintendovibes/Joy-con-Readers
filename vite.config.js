import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Plain http on purpose: the Mac's Chrome treats this address as secure via
// chrome://flags/#unsafely-treat-insecure-origin-as-secure (add
// http://172.16.122.81:5181), which is what Web Bluetooth / WebHID need.

// Dev-only: the Mac sends the station's log here, one JSON line per POST,
// appended to logs/<name>.jsonl on this PC.
const LOG_DIR = path.resolve(__dirname, 'logs')
function debugLog() {
  return {
    name: 'debug-log',
    configureServer(server) {
      server.middlewares.use('/__debug-log', (req, res) => {
        const name = new URL(req.url, 'http://x').searchParams.get('name') || 'debug'
        if (req.method !== 'POST' || !/^[\w-]{1,40}$/.test(name)) {
          res.statusCode = 400
          return res.end()
        }
        let body = ''
        req.on('data', chunk => {
          body += chunk
          if (body.length > 64 * 1024) req.destroy()
        })
        req.on('end', () => {
          fs.mkdirSync(LOG_DIR, { recursive: true })
          fs.appendFileSync(path.join(LOG_DIR, `${name}.jsonl`), body.trim() + '\n')
          res.end('ok')
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), debugLog()],
  server: {
    host: true,
    port: 5181,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8001',
        changeOrigin: true,
        rewrite: p => p.replace(/^\/api/, ''),
      },
    },
  },
})
