// Unit tests for the waveform bucketing — dependency-free (node:test), like
// instance-config.test.mjs. computePeaks is exported plainly; the self.onmessage
// wrapper is guarded so this import doesn't need a worker global.
//   node --test packages/web-app/waveform-worker.test.mjs
import { ok, strictEqual } from 'node:assert'
import { test } from 'node:test'
import { computePeaks } from './static/waveform-worker.js'

test('computePeaks: empty input → n zeros', () => {
  const p = computePeaks(new Float32Array(0), 8)
  strictEqual(p.length, 8)
  ok([...p].every(v => v === 0))
})

test('computePeaks: n<=0 → empty', () => {
  strictEqual(computePeaks(new Float32Array(4).fill(1), 0).length, 0)
})

// Float32Array stores ~7 significant digits, so compare with a float tolerance.
const near = (a, b) => Math.abs(a - b) < 1e-6

test('computePeaks: constant signal → constant peaks', () => {
  const p = computePeaks(new Float32Array(64).fill(0.5), 8)
  strictEqual(p.length, 8)
  ok([...p].every(v => near(v, 0.5)))
})

test('computePeaks: negative samples use absolute value', () => {
  const p = computePeaks(new Float32Array(64).fill(-0.7), 8)
  ok([...p].every(v => near(v, 0.7)))
})

test('computePeaks: a spike localizes to its bucket', () => {
  const data = new Float32Array(64)
  data[10] = -0.9 // bucket size 64/8 = 8, so sample 10 → bucket 1
  const p = computePeaks(data, 8)
  ok(near(p[1], 0.9))
  strictEqual([...p].filter(v => v !== 0).length, 1)
})

test('computePeaks: fewer samples than buckets → most buckets stay 0', () => {
  const data = new Float32Array([1, 1, 1])
  const p = computePeaks(data, 8)
  strictEqual(p.length, 8)
  ok(Math.max(...p) === 1)
  ok([...p].filter(v => v === 0).length >= 5)
})
