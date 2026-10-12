import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assignNumbers } from './patch-numbers.mjs'

// format-patch output: fixes numbered from 0001, everything else from 1000
const out = (fixes, rest) => [
  ...fixes.map((s, i) => `${String(i + 1).padStart(4, '0')}-${s}.patch`),
  ...rest.map((s, i) => `${1000 + i}-${s}.patch`),
]
const nums = (names) => names.map((n) => n.slice(0, 4)).join(' ')

test('an unchanged stack keeps every number', () => {
  const old = ['0001-f.patch', '1000-a.patch', '1001-b.patch', '1005-c.patch']
  assert.deepEqual(assignNumbers(old, out(['f'], ['a', 'b', 'c'])), old)
})

test('a removed patch leaves a gap', () => {
  const old = ['1000-a.patch', '1001-b.patch', '1002-c.patch']
  assert.equal(nums(assignNumbers(old, out([], ['a', 'c']))), '1000 1002')
})

test('a new patch at the end takes the next number', () => {
  const old = ['0001-f.patch', '1000-a.patch', '1002-c.patch']
  assert.equal(nums(assignNumbers(old, out(['f', 'g'], ['a', 'c', 'd']))), '0001 0002 1000 1002 1003')
})

test('a new patch in the middle takes a free number, or stops', () => {
  const gap = ['1000-a.patch', '1002-c.patch']
  assert.equal(nums(assignNumbers(gap, out([], ['a', 'x', 'c']))), '1000 1001 1002')
  const tight = ['1000-a.patch', '1001-c.patch']
  assert.throws(() => assignNumbers(tight, out([], ['a', 'x', 'c'])), /no free number for x.*RENUMBER=1/)
  assert.equal(nums(assignNumbers(tight, out([], ['a', 'x', 'c']), { renumber: true })), '1000 1001 1002')
})

test('a reworded subject keeps its number, matched by its diff', () => {
  const old = ['1000-a.patch', '1005-b.patch', '1006-c.patch']
  const ids = { oldIds: new Map([['1005-b.patch', 'id-b']]), newIds: new Map([['1001-b2.patch', 'id-b']]) }
  assert.equal(nums(assignNumbers(old, out([], ['a', 'b2', 'c']), ids)), '1000 1005 1006')
})

test("a removed patch's number is never handed to a new one", () => {
  const tight = ['1000-a.patch', '1001-b.patch', '1002-c.patch']
  assert.throws(() => assignNumbers(tight, out([], ['a', 'x', 'c'])), /no free number for x/)
  const roomy = ['1000-a.patch', '1001-b.patch', '1005-c.patch']
  assert.equal(nums(assignNumbers(roomy, out([], ['a', 'x', 'c']))), '1000 1002 1005')
  const tail = ['1000-a.patch', '1001-b.patch']
  assert.equal(nums(assignNumbers(tail, out([], ['a', 'x']))), '1000 1002')
})

test('a reorder renumbers only the moved patch', () => {
  const old = ['1000-a.patch', '1001-b.patch', '1002-c.patch', '1005-d.patch']
  // d moves between a and b: it can't keep 1005, everything else can
  assert.throws(() => assignNumbers(old, out([], ['a', 'd', 'b', 'c'])), /no free number for d/)
  const roomy = ['1000-a.patch', '1003-b.patch', '1004-c.patch', '1005-d.patch']
  assert.equal(nums(assignNumbers(roomy, out([], ['a', 'd', 'b', 'c']))), '1000 1001 1003 1004')
})

test('a patch that becomes an upstream fix moves to the fix range', () => {
  const old = ['0001-f.patch', '1000-a.patch', '1001-b.patch']
  assert.equal(nums(assignNumbers(old, out(['f', 'b'], ['a']))), '0001 0002 1000')
})

test('duplicate slugs are matched in order', () => {
  const old = ['1000-same.patch', '1001-x.patch', '1002-same.patch']
  assert.equal(nums(assignNumbers(old, out([], ['same', 'x', 'same']))), '1000 1001 1002')
})

test('the first run moves an old 0100+ stack into 1000+', () => {
  const old = ['0001-f.patch', '0100-a.patch', '0101-b.patch']
  assert.equal(nums(assignNumbers(old, out(['f'], ['a', 'b']))), '0001 1000 1001')
})
