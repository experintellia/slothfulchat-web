// Unit tests for the blobs SW's response shaping — dependency-free
// (node:test), so they run in CI's lint job without pnpm install / submodules.
//   node --test packages/web-app/src/blob-response.test.mjs
import { deepStrictEqual, match, strictEqual } from 'node:assert'
import { test } from 'node:test'

import { blobResponseInit } from './blob-response.mjs'

test('a sent .svg cannot become a same-origin scripted document (H-02)', () => {
  const { status, headers } = blobResponseInit(10, 'image/svg+xml', null, null)
  strictEqual(status, 200)
  // sandbox without allow-scripts/allow-same-origin = no script, opaque origin
  match(headers['content-security-policy'], /^sandbox(?! [^;]*allow-scripts)/)
  match(headers['content-security-policy'], /^sandbox(?! [^;]*allow-same-origin)/)
  match(headers['content-security-policy'], /default-src 'none'/)
  strictEqual(headers['x-content-type-options'], 'nosniff')
  // still served as an SVG: <img src> rendering must keep working
  strictEqual(headers['content-type'], 'image/svg+xml')
  strictEqual(headers['content-disposition'], undefined) // never forced inline->download
})

test('inline image serving is otherwise untouched', () => {
  const { status, headers, start, end } = blobResponseInit(7, 'image/png', null, null)
  deepStrictEqual({ status, start, end }, { status: 200, start: 0, end: 7 })
  strictEqual(headers['content-length'], '7')
  strictEqual(headers['accept-ranges'], 'bytes')
})

test('unknown extension keeps the octet-stream fallback (and is still guarded)', () => {
  const { headers } = blobResponseInit(3, undefined, null, null)
  strictEqual(headers['content-type'], 'application/octet-stream')
  strictEqual(headers['x-content-type-options'], 'nosniff')
})

test('media seeking: Range gives 206 with the right slice and headers', () => {
  const { status, headers, start, end } = blobResponseInit(
    100,
    'video/mp4',
    null,
    'bytes=10-19'
  )
  strictEqual(status, 206)
  strictEqual(headers['content-range'], 'bytes 10-19/100')
  strictEqual(headers['content-length'], '10')
  deepStrictEqual([start, end], [10, 20]) // exclusive end: subarray(10, 20)
  // open-ended and suffix ranges (what <video> actually sends first)
  deepStrictEqual(
    (({ status, start, end }) => ({ status, start, end }))(
      blobResponseInit(100, 'video/mp4', null, 'bytes=0-')
    ),
    { status: 206, start: 0, end: 100 }
  )
  deepStrictEqual(
    (({ status, start, end }) => ({ status, start, end }))(
      blobResponseInit(100, 'video/mp4', null, 'bytes=-20')
    ),
    { status: 206, start: 80, end: 100 }
  )
  // unsatisfiable range: 416 with an empty body slice
  const bad = blobResponseInit(100, 'video/mp4', null, 'bytes=200-300')
  deepStrictEqual(
    { status: bad.status, range: bad.headers['content-range'], start: bad.start, end: bad.end },
    { status: 416, range: 'bytes */100', start: 0, end: 0 }
  )
})

test('download path still sets its disposition, quotes stripped', () => {
  const { headers } = blobResponseInit(5, 'application/octet-stream', 'my "back\\up".tar', null)
  strictEqual(headers['content-disposition'], 'attachment; filename="my backup.tar"')
  strictEqual(headers['content-security-policy'], "sandbox allow-downloads; default-src 'none'")
})
