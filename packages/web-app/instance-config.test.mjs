// Unit tests for the pure config templating — dependency-free (node:test), so
// they run in CI's `lint` job without pnpm install / submodules.
//   node --test packages/web-app/instance-config.test.mjs
import { deepStrictEqual, strictEqual } from 'node:assert'
import { test } from 'node:test'
import { buildConfig, parsePublicBridges } from './instance-config.mjs'

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
