// Unit tests for the pure config templating — dependency-free (node:test), so
// they run in CI's `lint` job without pnpm install / submodules.
//   node --test packages/web-app/instance-config.test.mjs
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { test } from 'node:test'
import {
  DEFAULT_RELAY_DIRECTORY_URL,
  analyticsOrigin,
  buildConfig,
  imprintHtml,
  normalizeRelayDirectory,
  parsePublicBridges,
  patchCsp,
  privacyHtml,
} from './instance-config.mjs'
import { EVENTS, isCatalogEvent } from './src/events.mjs'

test('parsePublicBridges: multiple entries, URL up to first space', () => {
  deepStrictEqual(
    parsePublicBridges(
      'wss://a.example/bridge Community bridge, for testing; wss://b.example/bridge Backup bridge'
    ),
    [
      { url: 'wss://a.example/bridge', description: 'Community bridge, for testing' },
      { url: 'wss://b.example/bridge', description: 'Backup bridge' },
    ]
  )
})

test('parsePublicBridges: entry without description', () => {
  deepStrictEqual(parsePublicBridges('ws://localhost:9999'), [
    { url: 'ws://localhost:9999', description: '' },
  ])
})

test('parsePublicBridges: whitespace tolerated around entries and separators', () => {
  deepStrictEqual(
    parsePublicBridges('  wss://a.example/bridge   spaced   out  ;  ; wss://b.example '),
    [
      { url: 'wss://a.example/bridge', description: 'spaced   out' },
      { url: 'wss://b.example', description: '' },
    ]
  )
})

test('parsePublicBridges: malformed entries are dropped, valid ones kept', () => {
  deepStrictEqual(
    parsePublicBridges(
      'https://not-a-bridge.example nope; just words; wss://ok.example fine; wss:// empty host'
    ),
    [{ url: 'wss://ok.example', description: 'fine' }]
  )
})

test('parsePublicBridges: tolerates shell-style wrapping quotes', () => {
  // the whole value pasted with the SELFHOSTING example's double-quotes
  deepStrictEqual(
    parsePublicBridges('"wss://ws.host.de Community-run bridge, for testing;"'),
    [{ url: 'wss://ws.host.de', description: 'Community-run bridge, for testing' }]
  )
  // single quotes, multiple entries
  deepStrictEqual(
    parsePublicBridges("'wss://a.example/b Foo; wss://c.example/d Bar'"),
    [
      { url: 'wss://a.example/b', description: 'Foo' },
      { url: 'wss://c.example/d', description: 'Bar' },
    ]
  )
  // quotes hugging an individual URL token
  deepStrictEqual(parsePublicBridges('"wss://a.example/b" Foo'), [
    { url: 'wss://a.example/b', description: 'Foo' },
  ])
})

test('parsePublicBridges: empty / unset input', () => {
  deepStrictEqual(parsePublicBridges(''), [])
  deepStrictEqual(parsePublicBridges(undefined), [])
  deepStrictEqual(parsePublicBridges('   ;  ; '), [])
})

test('buildConfig: publicBridges wired from SLOTHFUL_PUBLIC_BRIDGES', () => {
  deepStrictEqual(buildConfig({}).publicBridges, [])
  const config = buildConfig({
    SLOTHFUL_PUBLIC_BRIDGES: 'wss://a.example/bridge Community bridge',
  })
  deepStrictEqual(config.publicBridges, [
    { url: 'wss://a.example/bridge', description: 'Community bridge' },
  ])
  // still JSON-serializable into config.js
  strictEqual(
    JSON.parse(JSON.stringify(config)).publicBridges[0].url,
    'wss://a.example/bridge'
  )
})

test('privacyHtml: analytics on renders the full events catalogue', () => {
  const config = buildConfig({ SLOTHFUL_PLAUSIBLE_DOMAIN: 'demo.example' })
  const html = privacyHtml(config, {})
  ok(html.includes('Anonymous usage statistics'))
  ok(html.includes('Exactly these events and nothing else'))
  for (const e of EVENTS) ok(html.includes(`<code>${e.name}</code>`), `missing event ${e.name}`)
  ok(html.includes('SELFHOSTING.md'))
  // opt-out wording: checkbox locations, not the old "asked once" dialog
  ok(html.includes('checkbox on\nthe welcome screen'))
  ok(!html.includes('asked once'))
})

test('privacyHtml: relay-providers note and accurate link-preview description', () => {
  const html = privacyHtml(buildConfig({}), {})
  // messages travel through separate relay/provider services
  ok(html.includes('their own privacy policies'))
  // link previews: opt-in per link, the bridge operator learns the URL
  ok(html.includes('the bridge operator learns that URL'))
  ok(html.includes('optional, experimental'))
})

test('privacyHtml: honest relay, e2e and provider-storage wording', () => {
  const html = privacyHtml(buildConfig({ SLOTHFUL_DEFAULT_PROXY: 'wss://relay.example' }), {})
  // relay: sees connection metadata and may log it; not necessarily reference impl
  ok(html.includes('may log'))
  ok(html.includes('IP address'))
  ok(html.includes('may not be the reference implementation'))
  ok(html.includes('connection metadata described above'))
  // e2e only between chatmail-capable contacts, plain email otherwise
  ok(html.includes('ordinary email'))
  ok(html.includes('but not end-to-end'))
  // the provider also holds messages (classic email keeps them server-side)
  ok(html.includes('keeps them on the mail server'))
  // no default relay → no "relay this instance provides by default" claim
  const noRelay = privacyHtml(buildConfig({}), {})
  ok(!noRelay.includes('connection metadata described above'))
  ok(noRelay.includes('no default relay configured'))
})

test('imprintHtml: qualified e2e claim', () => {
  const html = imprintHtml(buildConfig({}), {})
  ok(html.includes('chatmail-capable contacts'))
  ok(html.includes('ordinary email'))
})

test('isCatalogEvent: enforces the closed catalogue', () => {
  // valid event + props (annotated spec values match their bare form)
  ok(isCatalogEvent('link_preview', { action: 'accept' }))
  ok(isCatalogEvent('account_created', { transport: 'imap', method: 'chatmail' }))
  ok(isCatalogEvent('pageview', { mode: 'new', display: 'browser' }))
  // fewer props than the spec lists is fine (e.g. onboarding without reason)
  ok(isCatalogEvent('onboarding', { step: 'welcome' }))
  // a no-props event without props is fine
  ok(isCatalogEvent('qr_scan'))
  ok(isCatalogEvent('qr_scan', {}))
  // unknown event name
  ok(!isCatalogEvent('evil_event'))
  // unknown prop key
  ok(!isCatalogEvent('link_preview', { victim: 'accept' }))
  // value outside the fixed vocabulary
  ok(!isCatalogEvent('link_preview', { action: 'user@example.org' }))
  // props on an event that declares none
  ok(!isCatalogEvent('qr_scan', { action: 'accept' }))
})

test('privacyHtml: analytics off has the no-analytics statement and no events', () => {
  const html = privacyHtml(buildConfig({}), {})
  ok(html.includes('no usage data at all'))
  ok(!html.includes('Anonymous usage statistics'))
  for (const e of EVENTS) ok(!html.includes(`<code>${e.name}</code>`), `unexpected event ${e.name}`)
})

test('imprintHtml links the privacy policy', () => {
  ok(imprintHtml(buildConfig({}), {}).includes('privacy.html'))
})

test('normalizeRelayDirectory: unset/garbage → default, off/URL pass through', () => {
  strictEqual(normalizeRelayDirectory(undefined), '')
  strictEqual(normalizeRelayDirectory(''), '')
  strictEqual(normalizeRelayDirectory('not a url'), '')
  strictEqual(normalizeRelayDirectory('ftp://weird.example/x'), '')
  strictEqual(normalizeRelayDirectory('javascript:alert(1)'), '')
  strictEqual(normalizeRelayDirectory('off'), 'off')
  strictEqual(normalizeRelayDirectory(' OFF '), 'off')
  strictEqual(normalizeRelayDirectory('https://x.example/relays.json'), 'https://x.example/relays.json')
  // a ';' is legal in a URL path but would truncate the CSP directive — reject
  strictEqual(normalizeRelayDirectory('https://x.example/a;b'), '')
  // shell-style quotes pasted into a CI Variable are tolerated, including
  // padding inside the quotes
  strictEqual(normalizeRelayDirectory('"https://x.example/r.json"'), 'https://x.example/r.json')
  strictEqual(normalizeRelayDirectory('"  off  "'), 'off')
})

test('normalizeRelayDirectory: rejects multi-token / injecting values', () => {
  // the value is appended verbatim to connect-src, so a space would add a
  // SECOND source — must be rejected, not passed through
  strictEqual(
    normalizeRelayDirectory('https://good.example/r.json https://evil.example'),
    ''
  )
  strictEqual(normalizeRelayDirectory('https://x.example/r.json "extra"'), '')
})

test('patchCsp: relay-directory pin — default, custom, off; analytics coexists', () => {
  const base = `<meta content="default-src 'none';
                   connect-src 'self' ws: wss: data: blob: http://*:*/unfurl https://*:*/unfurl https://old.example/stale.json" />`
  // unset → default mirror pinned, stale relay pin dropped, unfurl preserved
  const def = patchCsp(base, '', '')
  ok(def.includes(`https://*:*/unfurl ${DEFAULT_RELAY_DIRECTORY_URL}"`))
  ok(!def.includes('old.example'))
  ok(def.includes('https://*:*/unfurl'))

  // custom URL swaps the pin
  const custom = patchCsp(base, '', 'https://x.example/relays.json')
  ok(custom.includes('https://x.example/relays.json"'))
  ok(!custom.includes('chatmail-relays-mirror'))

  // off → no relay pin at all
  const off = patchCsp(base, '', 'off')
  ok(!off.includes('relays.json'))
  ok(off.includes(`http://*:*/unfurl https://*:*/unfurl"`))

  // analytics origin and relay pin coexist
  const both = patchCsp(base, 'https://plausible.io', '')
  ok(both.includes('https://plausible.io'))
  ok(both.includes(DEFAULT_RELAY_DIRECTORY_URL))

  // idempotent for a clean custom value and for an injecting one (which falls
  // back to the default and must not accumulate)
  strictEqual(patchCsp(custom, '', 'https://x.example/relays.json'), custom)
  const inj = patchCsp(base, '', 'https://x.example/a;b')
  ok(!inj.includes('evil'))
  ok(inj.includes(DEFAULT_RELAY_DIRECTORY_URL))
  strictEqual(patchCsp(inj, '', 'https://x.example/a;b'), inj)
})

test('patchCsp: matches the real static/main.html CSP for unset config', async () => {
  const { readFile } = await import('node:fs/promises')
  const html = await readFile(new URL('./static/main.html', import.meta.url), 'utf-8')
  // the static default already pins the default mirror and no analytics, so
  // patchCsp for an unset instance must be a no-op — the template and the
  // rewriter agree on the base list + default pin
  strictEqual(patchCsp(html, '', ''), html)
  // and an override actually changes exactly the pin
  const custom = patchCsp(html, '', 'https://x.example/relays.json')
  ok(custom.includes('https://x.example/relays.json'))
  ok(!custom.includes(DEFAULT_RELAY_DIRECTORY_URL))
})

test('buildConfig: relayDirectoryUrl wired from SLOTHFUL_RELAY_DIRECTORY', () => {
  strictEqual(buildConfig({}).relayDirectoryUrl, '')
  strictEqual(buildConfig({ SLOTHFUL_RELAY_DIRECTORY: 'off' }).relayDirectoryUrl, 'off')
  strictEqual(
    buildConfig({ SLOTHFUL_RELAY_DIRECTORY: 'https://x.example/r.json' }).relayDirectoryUrl,
    'https://x.example/r.json'
  )
})

// Drift guard: the frontend's own default (RELAY_DIRECTORY_URL in the patched
// relayDirectory.ts) is what the app actually fetches when unset, while
// DEFAULT_RELAY_DIRECTORY_URL pins the CSP and lives in main.html — they MUST
// be byte-identical or the default picker silently fails under CSP (fetch to
// one host, connect-src allows another). The frontend source lives in the
// build/desktop worktree, invisible to this lint job, but it is captured in
// the committed relay-picker patch — assert against that.
test('frontend RELAY_DIRECTORY_URL default matches DEFAULT_RELAY_DIRECTORY_URL', async () => {
  const { readFile, readdir } = await import('node:fs/promises')
  const dir = new URL('../../patches/desktop/', import.meta.url)
  const files = (await readdir(dir)).filter(f => f.endsWith('.patch'))
  let match = null
  for (const f of files) {
    const patch = await readFile(new URL(f, dir), 'utf-8')
    const m = patch.match(
      /^\+export const RELAY_DIRECTORY_URL =\s*\n\+\s*'([^']+)'/m
    )
    if (m) {
      match = m[1]
      break
    }
  }
  strictEqual(
    match,
    DEFAULT_RELAY_DIRECTORY_URL,
    'frontend RELAY_DIRECTORY_URL (in patches/desktop) drifted from DEFAULT_RELAY_DIRECTORY_URL'
  )
})
