// Self-check for the bridge's opt-in unfurl endpoint — fully offline.
//
// A local OG page server plays "the internet" (reached as og.localhost, which
// the handler maps to loopback per RFC 6761). Guard tests run a bridge with
// the private-IP guard ON (loopback targets refused); functional tests run one
// with UNFURL_ALLOW_PRIVATE=1; enablement tests cover the default (on for an
// allow-all bridge, off once CHATMAIL_ALLOWLIST is set) and UNFURL=0. The
// address guard's range table is asserted in-process, and a short
// UNFURL_DEADLINE_MS bridge proves the absolute deadline (and the in-flight
// concurrency cap) against a slow drip.
// Run:  node scripts/test-unfurl.mjs
import { createServer } from 'node:http'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { isPrivateIp } from '../packages/ws-tcp-proxy/unfurl.mjs'

const servicePath = fileURLToPath(
  new URL('../packages/ws-tcp-proxy/ws-tcp-proxy.mjs', import.meta.url)
)

// --- SSRF address guard, checked against the real table (imported, not a
//     hand-kept copy). Only globally routable unicast may be fetched. ---
for (const ip of [
  '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254',
  '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1',
  '::ffff:127.0.0.1',        // dotted IPv4-mapped
  '::ffff:7f00:1',           // hex IPv4-mapped 127.0.0.1 (a past bypass)
  '::ffff:a9fe:a9fe',        // hex IPv4-mapped 169.254.169.254 metadata (a past bypass)
  '::',                      // unspecified
  '192.0.0.1', '192.0.2.5', '198.18.0.1', '198.51.100.7', '203.0.113.9',
  '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
  '2001:db8::1',             // documentation
  '::ffff:c000:2ff',         // hex IPv4-mapped 192.0.2.255
]) {
  assert.equal(isPrivateIp(ip), true, `expected ${ip} to be blocked`)
}
for (const ip of [
  '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '93.184.216.34',
  '99.255.255.255', '100.128.0.1', '192.0.1.1', '192.0.3.1',
  '198.17.255.255', '198.20.0.1', '198.51.99.1', '203.0.114.1',
  '223.255.255.255', '2001:db9::1',
]) {
  assert.equal(isPrivateIp(ip), false, `expected ${ip} to be allowed`)
}
assert.equal(isPrivateIp('example.com'), false) // hostnames go through the lookup guard
console.log('OK: address guard blocks the non-global ranges, permits public unicast')

// --- OG page server ---
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc00000030101' +
    '00c9fe92ef0000000049454e44ae426082',
  'hex'
)
const og = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  if (path === '/page.html') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end(`<!doctype html><html><head><title>Fallback &amp; title</title>
      <meta property="og:title" content="Unfurl &quot;works&quot;">
      <meta property="og:description" content="A &#39;description&#39;">
      <meta property="og:image" content="/img.png">
      <meta property="og:image:width" content="800">
      <meta property="og:image:height" content="400">
      <meta name="twitter:card" content="summary_large_image">
      </head><body>hi</body></html>`)
  }
  if (path === '/img.png') {
    res.setHeader('content-type', 'image/png')
    return res.end(PNG)
  }
  if (path === '/redirect') {
    res.statusCode = 302
    res.setHeader('location', '/page.html')
    return res.end()
  }
  if (path === '/huge.html') {
    // title up top, then a body far larger than the 1 MB page cap and NO
    // </head> — the YouTube shape. We should truncate and still parse.
    res.setHeader('content-type', 'text/html')
    res.write('<title>big</title>')
    return res.end('x'.repeat(2 * 1024 * 1024))
  }
  if (path === '/bigbody.html') {
    // og tags in a small <head>, then a multi-MB body — reading must stop at
    // </head> and never pull the body.
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.write(
      '<html><head><title>early</title>' +
        '<meta property="og:title" content="Stopped at head"></head><body>'
    )
    return res.end('x'.repeat(4 * 1024 * 1024))
  }
  if (path === '/bigimg.html') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end(
      '<head><title>has a huge image</title>' +
        `<meta property="og:image" content="${ogBase}/huge.png"></head>`
    )
  }
  if (path === '/drip.html' || path === '/drip.png') {
    // never finishes, never idles: a byte every 100 ms keeps the socket's
    // inactivity timeout from ever firing. Only an absolute deadline stops it.
    res.setHeader('content-type', path.endsWith('.png') ? 'image/png' : 'text/html')
    res.write('<html><head>')
    const t = setInterval(() => res.write('x'), 100)
    return res.on('close', () => clearInterval(t))
  }
  if (path === '/slowpage.html') {
    // 800 ms to answer, then points at a dripping image: the image fetch must
    // inherit what's left of the deadline, not start a fresh one.
    return setTimeout(() => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(
        '<html><head><title>slow</title>' +
          `<meta property="og:image" content="${ogBase}/drip.png"></head>`
      )
    }, 800)
  }
  if (path === '/huge.png') {
    res.setHeader('content-type', 'image/png')
    return res.end(Buffer.alloc(5 * 1024 * 1024)) // over the 4 MB image cap
  }
  res.statusCode = 404
  res.end()
})
await new Promise((r) => og.listen(0, '127.0.0.1', r))
const ogBase = `http://og.localhost:${og.address().port}`

// --- bridge instances. A clean env (UNFURL / allowlist stripped) so the
//     default-behaviour checks below are deterministic. ---
const startService = (port, env = {}) => {
  const base = { ...process.env }
  delete base.UNFURL
  delete base.UNFURL_ALLOW_PRIVATE
  delete base.CHATMAIL_ALLOWLIST
  delete base.CHATMAIL_WHITELIST
  return fork(servicePath, [], {
    env: { ...base, PORT: String(port), ...env },
    stdio: 'inherit',
  })
}
const guarded = startService(8655, { UNFURL: '1' }) // explicit on, guard on
const open = startService(8656, { UNFURL: '1', UNFURL_ALLOW_PRIVATE: '1' }) // functional
const explicitOff = startService(8658, { UNFURL: '0' })
const defaultLocal = startService(8659, {}) // no allowlist → default on
const defaultHosted = startService(8660, { CHATMAIL_ALLOWLIST: 'example.com' }) // allowlist → default off
// short absolute deadline so the drip tests below finish in ~1 s, not ~20
const impatient = startService(8661, { UNFURL: '1', UNFURL_ALLOW_PRIVATE: '1', UNFURL_DEADLINE_MS: '1200' })
// Wait until each bridge really listens — a fixed sleep raced six forks on a
// loaded machine. Any answer counts (404 = up, unfurl just disabled).
const waitReady = async (...ports) => {
  for (let i = 0; i < 100; i++) {
    const up = await Promise.all(
      ports.map((p) => fetch(`http://127.0.0.1:${p}/unfurl`).then(() => true, () => false))
    )
    if (up.every(Boolean)) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`bridges never started listening on ${ports.join(', ')}`)
}
await waitReady(8655, 8656, 8658, 8659, 8660, 8661)

const unfurl = (base, url, init) =>
  fetch(`${base}/unfurl?url=${encodeURIComponent(url)}`, init)
// /unfurl with no ?url= → 400 when the endpoint is enabled, 404 when it isn't
const probe = (base) => fetch(`${base}/unfurl`).then((r) => r.status)

try {
  // functional: metadata + inline image, entities decoded, redirects followed
  const res = await unfurl('http://127.0.0.1:8656', `${ogBase}/page.html`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  const data = await res.json()
  assert.equal(data.title, 'Unfurl "works"')
  assert.equal(data.description, "A 'description'")
  assert.equal(data.twitterCard, 'summary_large_image')
  assert.equal(data.imageWidth, 800)
  assert.equal(data.imageMime, 'image/png')
  assert.equal(Buffer.from(data.image, 'base64').toString('hex'), PNG.toString('hex'))
  console.log('OK: metadata + image unfurled, entities decoded')

  const viaRedirect = await unfurl('http://127.0.0.1:8656', `${ogBase}/redirect`)
  assert.equal(viaRedirect.status, 200)
  assert.equal((await viaRedirect.json()).title, 'Unfurl "works"')
  console.log('OK: redirects followed')

  // guard: loopback (via *.localhost and raw IP) refused when the guard is on
  for (const target of [`${ogBase}/page.html`, `http://127.0.0.1:${og.address().port}/page.html`]) {
    const blocked = await unfurl('http://127.0.0.1:8655', target)
    assert.equal(blocked.status, 502, `${target} must be refused`)
    assert.match((await blocked.json()).error, /private/)
  }
  console.log('OK: private/loopback targets refused')

  // method / input validation
  assert.equal((await unfurl('http://127.0.0.1:8656', `${ogBase}/page.html`, { method: 'POST' })).status, 405)
  assert.equal((await fetch('http://127.0.0.1:8656/unfurl')).status, 400)
  assert.equal((await unfurl('http://127.0.0.1:8656', 'ftp://example.com/x')).status, 502)
  console.log('OK: GET-only, missing/bad URL rejected')

  // enablement: default on for an allow-all bridge, off once an allowlist is
  // set; UNFURL=0 forces off. (400 = enabled but missing ?url=; 404 = absent.)
  assert.equal(await probe('http://127.0.0.1:8659'), 400, 'allow-all bridge enables unfurl by default')
  assert.equal(await probe('http://127.0.0.1:8660'), 404, 'allowlisted bridge disables unfurl by default')
  assert.equal(await probe('http://127.0.0.1:8658'), 404, 'UNFURL=0 forces it off')
  console.log('OK: on for allow-all, off for allowlisted / UNFURL=0')

  // oversized page with no </head> (YouTube shape): truncate + parse, not 502
  const huge = await unfurl('http://127.0.0.1:8656', `${ogBase}/huge.html`)
  assert.equal(huge.status, 200)
  assert.equal((await huge.json()).title, 'big')
  // small <head> then a multi-MB body: reading stops at </head>, still parses
  const early = await unfurl('http://127.0.0.1:8656', `${ogBase}/bigbody.html`)
  assert.equal(early.status, 200)
  assert.equal((await early.json()).title, 'Stopped at head')
  // an over-cap og:image is dropped (image:null) but the metadata still returns
  const bigimg = await unfurl('http://127.0.0.1:8656', `${ogBase}/bigimg.html`)
  assert.equal(bigimg.status, 200)
  const bigimgData = await bigimg.json()
  assert.equal(bigimgData.title, 'has a huge image')
  assert.equal(bigimgData.image, null)
  console.log('OK: big pages parsed (head-only), over-cap image dropped')

  // absolute deadline: a slow drip never trips the per-socket inactivity
  // timeout, so only the wall-clock ceiling can end it
  const dripStart = Date.now()
  const dripped = await unfurl('http://127.0.0.1:8661', `${ogBase}/drip.html`)
  assert.equal(dripped.status, 502)
  assert.match((await dripped.json()).error, /deadline/)
  assert.ok(Date.now() - dripStart < 5000, 'drip must be cut off by the deadline, not hang')
  // …and the deadline is shared: 800 ms of page + a dripping image must still
  // end at ~1.2 s total, not 800 ms + a fresh 1.2 s for the image
  const sharedStart = Date.now()
  const shared = await unfurl('http://127.0.0.1:8661', `${ogBase}/slowpage.html`)
  const sharedMs = Date.now() - sharedStart
  assert.equal(shared.status, 200)
  assert.equal((await shared.json()).image, null) // image fetch hit the deadline
  assert.ok(sharedMs < 1800, `page+image must share one deadline (took ${sharedMs}ms)`)
  console.log('OK: one absolute deadline spans redirects, page and image')

  // concurrency cap: the rate limit counts requests per minute, not how many
  // run at once. Six simultaneous drips (each of which would hold a socket and
  // its buffers for the whole deadline) must not all be admitted — and the
  // slots must come back afterwards.
  const burst = await Promise.all(
    Array.from({ length: 6 }, () => unfurl('http://127.0.0.1:8661', `${ogBase}/drip.html`))
  )
  const rejected = burst.filter((r) => r.status === 503).length
  assert.equal(rejected, 2, `4 in flight, 2 refused — got ${burst.map((r) => r.status).join(',')}`)
  const afterBurst = await unfurl('http://127.0.0.1:8661', `${ogBase}/page.html`)
  assert.equal(afterBurst.status, 200, 'in-flight slots must be released when a request ends')
  console.log('OK: concurrency cap refuses the overflow and releases its slots')

  // rate limit (fresh service so earlier calls don't count)
  const limited = startService(8657, { UNFURL_ALLOW_PRIVATE: '1' })
  await waitReady(8657)
  let last
  for (let i = 0; i < 31; i++) last = await unfurl('http://127.0.0.1:8657', `${ogBase}/page.html`)
  assert.equal(last.status, 429)
  limited.kill()
  console.log('OK: rate limit kicks in')

  console.log('OK: unfurl service self-check passed')
  process.exitCode = 0
} catch (err) {
  console.error('FAIL:', err)
  process.exitCode = 1
} finally {
  guarded.kill()
  open.kill()
  explicitOff.kill()
  defaultLocal.kill()
  defaultHosted.kill()
  impatient.kill()
  og.closeAllConnections()
  og.close()
}
