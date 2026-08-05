// The repo's dev static server. Serves the web-app's dist/ by default; the
// core-wasm example (packages/core-wasm: `pnpm example`) points it elsewhere
// with the three env knobs below rather than keeping a second copy of this.
//
//   SERVE_ROOT      absolute dir to serve (default: this package's dist/;
//                   tests point it at a minimal temp dir)
//   SERVE_BOUNDARY  absolute dir a resolved path must stay inside (default:
//                   SERVE_ROOT). The example serves a directory whose deps are
//                   pnpm symlinks out into the workspace, so it widens the
//                   boundary to the repo root instead of dropping the check.
//   SERVE_INDEX     what "/" maps to (default: main.html)
import { createServer } from 'node:http'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.env.SERVE_ROOT ?? fileURLToPath(new URL('./dist', import.meta.url))
const PORT = Number(process.env.PORT ?? 8642)
const INDEX = process.env.SERVE_INDEX ?? 'main.html'
// Resolved once at startup: realpath is what makes the boundary check hold
// even when the path we resolve runs through a symlink.
const boundary = await realpath(process.env.SERVE_BOUNDARY ?? root)

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
    if (urlPath === '/') urlPath = `/${INDEX}`
    // realpath before the check, so a symlink can't point out of the boundary;
    // it also 404s a missing file here rather than at readFile.
    const path = await realpath(normalize(join(root, urlPath)))
    // `boundary + sep`, not a bare prefix: /repo must not match /repo-evil.
    if (path !== boundary && !path.startsWith(boundary + sep)) throw new Error('traversal')
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
  console.log(`serving ${root} — http://localhost:${PORT}/${INDEX}`)
})
