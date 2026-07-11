// Self-check for the bridge's opt-in unfurl endpoint — fully offline.
//
// A local OG page server plays "the internet" (reached as og.localhost, which
// the handler maps to loopback per RFC 6761). Guard tests run a bridge with
// the private-IP guard ON (loopback targets refused); functional tests run one
// with UNFURL_ALLOW_PRIVATE=1; enablement tests cover the default (on for an
// allow-all bridge, off once CHATMAIL_ALLOWLIST is set) and UNFURL=0.
// Run:  node scripts/test-unfurl.mjs
import { createServer } from 'node:http'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const servicePath = fileURLToPath(
  new URL('../packages/ws-tcp-proxy/ws-tcp-proxy.mjs', import.meta.url)
)

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
await new Promise((r) => setTimeout(r, 500))

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

  // rate limit (fresh service so earlier calls don't count)
  const limited = startService(8657, { UNFURL_ALLOW_PRIVATE: '1' })
  await new Promise((r) => setTimeout(r, 500))
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
  og.close()
}
