/**
 * Minimal static file server for local testing.
 *
 *   node scripts/serve.mjs [port]
 *
 * No dependencies — serves the repo root so index.html can be opened at
 * http://localhost:8080/ exactly as it will be served by GitHub Pages.
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname, normalize } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.argv[2]) || 8080

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.wasm': 'application/wasm',
}

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    if (urlPath === '/') urlPath = '/index.html'

    // Keep requests inside the repo root.
    const filePath = join(root, normalize(urlPath).replace(/^(\.\.[/\\])+/, ''))
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end('Forbidden')
      return
    }

    const info = await stat(filePath).catch(() => null)
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: ' + urlPath)
      return
    }

    const body = await readFile(filePath)
    res.writeHead(200, {
      'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    })
    res.end(body)
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Server error: ' + err.message)
  }
})

server.listen(port, () => {
  console.log(`serving ${root}`)
  console.log(`  http://localhost:${port}/`)
})
