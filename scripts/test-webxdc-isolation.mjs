// Self-check for the webxdc wildcard-subdomain foundation (WEBXDC.md): each
// *.webxdc.app.localhost origin must get its own localStorage. Starts the
// dev harness (packages/web-app/dev-caddy.mjs — requires the `caddy` binary,
// any stock build) and drives Chromium against two subdomains.
// Requires packages/web-app/dist to exist (assembled at least once).
// Run:  node scripts/test-webxdc-isolation.mjs
import assert from 'node:assert'
import { request } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const webApp = fileURLToPath(new URL('../packages/web-app', import.meta.url))
const harness = spawn('node', ['dev-caddy.mjs'], { cwd: webApp, stdio: 'inherit' })
harness.on('exit', code => {
  if (!done) {
    console.error(`harness exited early (${code}) — is caddy installed?`)
    process.exit(2)
  }
})
let done = false

// Always tear the harness down — a failed assert must not leave caddy +
// serve.mjs holding :8642 for the next run.
let browser
try {
  // Wait for Caddy to answer (Host-header routing, so plain 127.0.0.1 + Host works)
  for (let i = 0; ; i++) {
    const up = await new Promise(res => {
      request({ host: '127.0.0.1', port: 8642, headers: { host: 'app.localhost:8642' } }, r => {
        r.resume()
        res(true)
      }).on('error', () => res(false)).end()
    })
    if (up) break
    assert(i < 50, 'harness did not come up on :8642')
    await new Promise(r => setTimeout(r, 200))
  }

  browser = await chromium.launch({
    // Chromium resolves *.localhost to loopback; the rule pins it (same as
    // scripts/test-link-preview-e2e.mjs).
    args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1'],
  })
  const page = await browser.newPage()
  const read = async url => {
    await page.goto(url)
    return {
      id: await page.locator('#id').textContent(),
      status: await page.locator('#status').textContent(),
    }
  }

  const a1 = await read('http://a.webxdc.app.localhost:8642/')
  assert(a1.status.startsWith('CREATED'), 'first visit on a. should create')
  const a2 = await read('http://a.webxdc.app.localhost:8642/some/deep/path')
  assert.equal(a2.id, a1.id, 'same origin must keep the id (any path)')
  assert(a2.status.startsWith('READ BACK'), 'second visit on a. should read back')
  const b = await read('http://b.webxdc.app.localhost:8642/')
  assert(b.status.startsWith('CREATED'), 'first visit on b. should create')
  assert.notEqual(b.id, a1.id, 'different subdomain must get its own storage')

  console.log('PASS: per-origin ids', { a: a1.id, b: b.id })
} finally {
  done = true
  await browser?.close().catch(() => {})
  harness.kill()
}
