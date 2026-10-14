// node --test packages/web-app/src/webxdc-origin.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appEntry, appOriginOf, cacheKey, mimeOf, xdcOrigin, xdcPath, xdcSlug } from './webxdc-origin.ts'

const prod = { protocol: 'https:', host: 'web.slothful.chat' }
const dev = { protocol: 'http:', host: 'localhost:8642' }

test('origin naming round-trips (WEBXDC.md table)', () => {
  const o = xdcOrigin(prod, xdcSlug('k3j9x0q2pz', 42))
  assert.equal(o, 'https://k3j9x0q2pzm42.webxdc.web.slothful.chat')
  assert.equal(appOriginOf(new URL(o)), 'https://web.slothful.chat')
  assert.equal(appOriginOf(new URL(xdcOrigin(dev, 'abc'))), 'http://localhost:8642')
})

test('a slug that is not one lowercase DNS label is refused', () => {
  for (const bad of ['', 'A1', 'a.b', 'a-b', 'x'.repeat(64), '../x']) {
    assert.throws(() => xdcOrigin(prod, bad), /bad webxdc slug/, bad)
  }
})

test('only <label>.webxdc.<host> is a webxdc origin', () => {
  assert.equal(appOriginOf(prod), null)
  assert.equal(appOriginOf({ protocol: 'https:', host: 'webxdc.web.slothful.chat' }), null)
  assert.equal(appOriginOf({ protocol: 'https:', host: 'a.b.webxdc.x' }), null) // two labels
  assert.equal(appOriginOf({ protocol: 'https:', host: 'evil.com' }), null)
})

test('zip names and request paths agree on one cache key', () => {
  const o = 'https://a.webxdc.x'
  const pairs: [string, string][] = [
    ['index.html', '/index.html'],
    ['img dir/a b#c.png', '/img%20dir/a%20b%23c.png'],
    ['sub/index.html', '/sub/'],
    ['index.html', '/'],
    ['./x.js', '/x.js'],
    ['ü.txt', '/%C3%BC.txt'],
  ]
  for (const [zip, req] of pairs) {
    assert.equal(cacheKey(o, xdcPath(zip, false)!), cacheKey(o, xdcPath(req, true)!), `${zip} vs ${req}`)
  }
  assert.equal(xdcPath('/%E0%A4%A', true), null) // malformed escape
})

test('a sender-supplied href never leaves the app origin', () => {
  assert.equal(appEntry(''), '/index.html')
  assert.equal(appEntry(null), '/index.html')
  assert.equal(appEntry('page.html#pos=3'), '/page.html#pos=3')
  assert.equal(appEntry('https://evil.com/x?y#z'), '/x?y#z')
  assert.equal(appEntry('//evil.com/x'), '/x')
  assert.equal(appEntry('/\\evil.com'), '/')
  assert.ok(appEntry('javascript:alert(1)').startsWith('/'))
assert.equal(appEntry('//['), '/index.html')
})

test('unknown types stay inert bytes', () => {
  assert.equal(mimeOf('a/INDEX.HTML'), 'text/html')
  assert.equal(mimeOf('x.wasm'), 'application/wasm')
  assert.equal(mimeOf('noext'), 'application/octet-stream')
  assert.equal(mimeOf('evil.exe'), 'application/octet-stream')
})
