// ponytail: one runnable check for the only non-trivial pure logic here.
// Run: node src/findActiveToken.test.mjs
import assert from 'node:assert/strict'
import { findActiveToken } from './findActiveToken.js'

const O = { trigger: ':', minChars: 2 }
const at = s => s.indexOf('|')            // caret marker
const t = s => s.replace('|', '')

const tok = (s, opts = O) => findActiveToken(t(s), at(s), opts)

// fires after `:` + 2 chars, reports the term and range
assert.deepEqual(tok('hi :sm|'), { trigger: ':', term: 'sm', start: 3, end: 6 })
assert.equal(tok('hi :sm|').start, 3)

// lone colon / single char stays quiet
assert.equal(tok(':|'), null)
assert.equal(tok('go :s|'), null)

// boundary guard: no menu inside URLs or times
assert.equal(tok('see http://ho|st'), null)
assert.equal(tok('at 12:30|'), null)

// trigger at start of input is a valid boundary
assert.deepEqual(tok(':sm|'), { trigger: ':', term: 'sm', start: 0, end: 3 })

// whitespace inside the term ends the token
assert.equal(tok('hi :sm |'), null)

// an already-closed :shortcode: does not re-trigger (caret after the 2nd colon)
assert.equal(tok('hi :smile:|'), null)

console.log('findActiveToken: all assertions passed')
