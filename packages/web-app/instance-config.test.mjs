// Unit tests for the pure config templating — dependency-free (node:test), so
// they run in CI's `lint` job without pnpm install / submodules.
//   node --test packages/web-app/instance-config.test.mjs
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { test } from 'node:test'
import { buildConfig, imprintHtml, parsePublicBridges, privacyHtml } from './instance-config.mjs'
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
