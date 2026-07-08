// Static server for dist/ — same pattern as scripts/serve-example.mjs.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('./dist', import.meta.url))
const PORT = Number(process.env.PORT ?? 8642)

const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
}

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    if (urlPath === '/') urlPath = '/main.html'
    const path = normalize(join(root, urlPath))
    if (!path.startsWith(root)) throw new Error('traversal')
    // without a validator nothing is cacheable and firefox re-downloads the
    // 10MB emoji font (and the wasm) on every single use/page load
    const lastModified = (await stat(path)).mtime.toUTCString()
    res.setHeader('last-modified', lastModified)
    res.setHeader('cache-control', 'no-cache') // always revalidate, dev server
    if (req.headers['if-modified-since'] === lastModified) {
      res.statusCode = 304
      return res.end()
    }
    const data = await readFile(path)
    res.setHeader('content-type', types[extname(path)] ?? 'application/octet-stream')
    res.end(data)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
})
server.listen(PORT, () => {
  console.log(`web-app: http://localhost:${PORT}/main.html`)
})
