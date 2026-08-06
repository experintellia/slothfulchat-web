// Unit tests for the blobs SW's cache ownership + shell routing —
// dependency-free (node:test), so they run in CI's lint job without pnpm
// install / submodules.
//   node --test packages/web-app/src/sw-cache.test.ts
import { strictEqual } from 'node:assert'
import { test } from 'node:test'

import { cacheName, isOwnCache, shellRole } from './sw-cache.ts'

const SCOPE = '/slothfulchat-web/' // GitHub Pages serves the app from /repo/
const MANIFEST = { 'main.html': 'abc', 'locales/en.json': 'def' }

// The finding: activate deleted every cache on the origin but the current one.
test('activation leaves caches this app does not own alone', () => {
  const ours = cacheName(SCOPE, 'v2')
  const keys = [
    ours,
    cacheName(SCOPE, 'v1'), // our previous deploy — still ours to drop
    cacheName('/other-app/', 'v9'), // same app, another base path: not ours
    'webimap-session', // a co-hosted application's cache
    'workbox-precache-v2-https://example.org/',
  ]
  strictEqual(
    keys.filter(k => k !== ours && isOwnCache(k, SCOPE)).join(),
    cacheName(SCOPE, 'v1')
  )
})

// Migration: names carried no scope before this change. If they stopped
// matching, a pre-rename shell would never be evicted.
test('the first activate after the rename still drops pre-rename caches', () => {
  strictEqual(isOwnCache('slothful-shell-deadbeef', SCOPE), true)
  strictEqual(isOwnCache('slothful-shell-deadbeef', '/'), true)
})

test('a root-scoped deploy does not claim another app on the origin', () => {
  strictEqual(isOwnCache('some-other-cache', '/'), false)
  strictEqual(isOwnCache(cacheName('/', 'v1'), '/'), true)
})

// The scope in the name is only ours if nothing else follows it: without the
// slash-free-remainder check, scope '/' would swallow every scoped cache on
// the origin — including a second copy of this app nested at /beta/.
test('a deploy does not claim a deploy nested under its scope', () => {
  strictEqual(isOwnCache(cacheName('/beta/', 'v1'), '/'), false)
  strictEqual(isOwnCache(cacheName('/app/nested/', 'v1'), '/app/'), false)
})

// The other half of the finding: catch-all caching with ignoreSearch. Only
// manifest files get the query-insensitive treatment; a co-hosted endpoint is
// not cached or matched at all, so two of its query-distinct GETs can never be
// answered from one cache entry.
test('manifest files are precache, under the base path', () => {
  strictEqual(shellRole('/slothfulchat-web/main.html', SCOPE, MANIFEST, true), 'precache')
  strictEqual(shellRole('/slothfulchat-web/locales/en.json', SCOPE, MANIFEST, false), 'precache')
})

test('a co-hosted endpoint on the same origin is left to the network', () => {
  strictEqual(shellRole('/webimap/fetch', SCOPE, MANIFEST, false), null)
  strictEqual(shellRole('/help/en/help.html', SCOPE, MANIFEST, true), null)
  // and at the root scope, where everything shares the app's path prefix
  strictEqual(shellRole('/webimap/fetch', '/', MANIFEST, false), null)
})

test('opt-in emoji fonts stay runtime-cacheable — they are left out of the manifest', () => {
  const font = '/slothfulchat-web/fonts/emoji-sets/twemoji.woff2'
  strictEqual(shellRole(font, SCOPE, MANIFEST, false), 'runtime')
})

test('an in-scope navigation may fall back to the shell, without being cached', () => {
  strictEqual(shellRole('/slothfulchat-web/', SCOPE, MANIFEST, true), 'shell')
  // same URL as a subresource fetch is nobody's business
  strictEqual(shellRole('/slothfulchat-web/', SCOPE, MANIFEST, false), null)
})

// __PRECACHE is a plain object literal, so `'constructor' in manifest` is true.
test('a prototype key is not a manifest entry', () => {
  strictEqual(shellRole('/slothfulchat-web/constructor', SCOPE, MANIFEST, false), null)
})
