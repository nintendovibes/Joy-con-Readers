import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Web Bluetooth only works on trusted secure pages. certs/ holds copies of
// Bowser Jr's dev certificate, which the Mac already trusts, so the station
// runs on https://172.16.122.81:5181. certs/ is git-ignored.
const certFile = name => path.resolve(__dirname, 'certs', name)
const hasCerts = ['server.key', 'server.crt'].every(f => fs.existsSync(certFile(f)))

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
    https: hasCerts
      ? { key: fs.readFileSync(certFile('server.key')), cert: fs.readFileSync(certFile('server.crt')) }
      : undefined,
    proxy: {
      '/api': {
        target: 'http://localhost:8001',
        changeOrigin: true,
        rewrite: p => p.replace(/^\/api/, ''),
      },
    },
  },
})
