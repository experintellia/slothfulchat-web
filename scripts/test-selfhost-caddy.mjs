// Self-check for the shipped self-hosting webserver config (SELFHOSTING.md).
// Runs a REAL caddy against packages/web-app/caddy/{Caddyfile.example,
// routes.caddy} with only the "# <- edit" values substituted, because both
// things below are silent when they break — they need a live server to see:
//
//  1. The frame policy. `frame-ancestors 'none'` everywhere, EXCEPT
//     html-email.html, which the mobile/PWA HTML-mail viewer loads in a
//     same-origin iframe of that very origin (ensureHtmlEmailDialog in
//     runtime.ts; desktop gets a popup, so this only breaks on phones). The two
//     header blocks must stay disjoint: caddy sorts a path-matched `header`
//     ahead of an unmatched one, so writing the second as an "override" of a
//     site-wide default silently leaves 'none' in place.
//  2. The /bridge route strips its prefix. The bridge reads the FIRST path
//     segment as the endpoint kind (/dns/<host>, /tcp/<ip>/<port>), so a proxy
//     that forwards /bridge/dns/... upgrades the WebSocket and then fails every
//     operation. The upstream here is a stub that echoes the path it received —
//     the path is the entire bug.
//
// Run:  node scripts/test-selfhost-caddy.mjs   (needs caddy in PATH)
import assert from 'node:assert'
import { createServer, get } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const caddyDir = fileURLToPath(new URL('../packages/web-app/caddy/', import.meta.url))
const PORT = Number(process.env.PORT ?? 8644)
const STUB_PORT = PORT + 1
const HOST = `app.localhost:${PORT}`

const G = mkdtempSync(join(tmpdir(), 'selfhost-caddy-'))
mkdirSync(join(G, 'web'))
writeFileSync(join(G, 'web', 'index.html'), 'app')
writeFileSync(join(G, 'web', 'html-email.html'), 'viewer')
writeFileSync(join(G, 'routes.caddy'), readFileSync(join(caddyDir, 'routes.caddy')))
// Exactly the edits an operator makes, plus a global block pinning http_port to
// our port so the hostname sites serve plain HTTP (no certs in a self-test).
writeFileSync(
  join(G, 'Caddyfile'),
  `{\n\thttp_port ${PORT}\n}\n` +
    readFileSync(join(caddyDir, 'Caddyfile.example'), 'utf8')
      .replaceAll('example.com', HOST)
      .replaceAll('/srv/slothfulchat/dist', join(G, 'web'))
      .replaceAll('127.0.0.1:8641', `127.0.0.1:${STUB_PORT}`)
)

const stub = createServer((req, res) => res.end(`STUB ${req.url}`))
stub.listen(STUB_PORT, '127.0.0.1')

const caddy = spawn('caddy', ['run', '--config', join(G, 'Caddyfile'), '--adapter', 'caddyfile'], {
  cwd: G,
  stdio: 'inherit',
})
let done = false
caddy.on('exit', code => {
  if (!done) {
    console.error(`caddy exited early (${code}) — is caddy installed?`)
    process.exit(2)
  }
})

const fetchPath = path =>
  new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port: PORT, path, headers: { host: HOST } }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    }).on('error', reject)
  })

try {
  for (let i = 0; ; i++) {
    try {
      await fetchPath('/index.html')
      break
    } catch {
      assert(i < 50, 'caddy did not come up')
      await new Promise(r => setTimeout(r, 200))
    }
  }

  const app = await fetchPath('/index.html')
  assert.equal(app.headers['content-security-policy'], "frame-ancestors 'none'")
  assert.equal(app.headers['x-frame-options'], 'DENY')

  const viewer = await fetchPath('/html-email.html')
  assert.equal(viewer.headers['content-security-policy'], "frame-ancestors 'self'")
  assert.equal(viewer.headers['x-frame-options'], 'SAMEORIGIN')
  // the shared headers must survive the split into two header blocks
  assert.equal(viewer.headers['x-content-type-options'], 'nosniff')
  assert.equal(viewer.headers['referrer-policy'], 'no-referrer')

  const bridge = await fetchPath('/bridge/dns/localhost')
  assert.equal(
    bridge.body,
    'STUB /dns/localhost',
    `bridge route must strip the /bridge prefix (got ${JSON.stringify(bridge.body)})`
  )

  console.log('PASS: frame policy per route, /bridge prefix stripped')
} finally {
  done = true
  caddy.kill()
  stub.close()
  rmSync(G, { recursive: true, force: true })
}
