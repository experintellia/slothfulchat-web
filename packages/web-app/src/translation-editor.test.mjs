// Unit tests for the pure translation-editor helpers — dependency-free
// (node:test), so they run in CI's lint job without pnpm install / submodules.
//   node --test packages/web-app/src/translation-editor.test.mjs
import { deepStrictEqual, strictEqual } from 'node:assert'
import { test } from 'node:test'

import {
  escapeAndroid,
  matchKeys,
  mergeOverlay,
  toAndroidXml,
} from './translation-editor.mjs'

test('mergeOverlay replaces edited keys, is lossless for plural forms, no mutation', () => {
  const messages = {
    ok: { message: 'OK' },
    n_msgs: { one: '%1$d message', other: '%1$d messages' },
    untouched: { message: 'keep' },
  }
  const overlay = {
    ok: { message: 'Okay' },
    n_msgs: { one: '%1$d Nachricht', other: '%1$d Nachrichten' },
  }
  const out = mergeOverlay(overlay, messages)
  strictEqual(out.ok.message, 'Okay')
  strictEqual(out.n_msgs.other, '%1$d Nachrichten')
  strictEqual(out.untouched.message, 'keep') // untouched key preserved
  strictEqual(messages.ok.message, 'OK') // input not mutated
})

test('mergeOverlay with no overlay returns messages unchanged', () => {
  const m = { a: { message: 'x' } }
  strictEqual(mergeOverlay(undefined, m), m)
})

test('escapeAndroid mirrors the build converter round-trip', () => {
  strictEqual(
    escapeAndroid('Tom\'s <b> & "q"\nline'),
    'Tom\\\'s &lt;b&gt; &amp; \\"q\\"\\nline'
  )
})

test('matchKeys resolves candidates longest-first, dedups, keeps ambiguity', () => {
  const registry = new Map([
    ['OK', new Set(['ok', 'confirm'])],
    ['Write a message…', new Set(['write_message_desktop'])],
  ])
  const rows = matchKeys(registry, [
    'OK',
    'Write a message…',
    'OK', // duplicate candidate ignored
    'not a translated string',
  ])
  strictEqual(rows.length, 2)
  strictEqual(rows[0].text, 'Write a message…') // longest first
  deepStrictEqual(rows[1].keys, ['confirm', 'ok']) // sorted, both kept
})

test('matchKeys returns nothing when no candidate is in the registry', () => {
  deepStrictEqual(matchKeys(new Map(), ['x', '', '  ']), [])
})

test('toAndroidXml emits a sorted partial with strings and plurals', () => {
  const xml = toAndroidXml({
    ok: { message: "It's OK" },
    n_msgs: { one: '%1$d message', other: '%1$d messages' },
  })
  strictEqual(
    xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<resources>'),
    true
  )
  // sorted by key: n_msgs before ok
  strictEqual(xml.indexOf('n_msgs') < xml.indexOf('name="ok"'), true)
  strictEqual(xml.includes('<plurals name="n_msgs">'), true)
  strictEqual(xml.includes('<item quantity="one">%1$d message</item>'), true)
  strictEqual(xml.includes('<string name="ok">It\\\'s OK</string>'), true)
})
