// Unit tests for the blobs SW's route resolution — dependency-free
// (node:test), so they run in CI's lint job without pnpm install / submodules.
//   node --test packages/web-app/src/blob-route.test.mjs
import { deepStrictEqual, strictEqual } from 'node:assert'
import { test } from 'node:test'

import { isBlobRoute, resolveBlobRoute } from './blob-route.mjs'

test('a blobdir file resolves to its account and name', () => {
  deepStrictEqual(resolveBlobRoute('/blobs/1/photo.jpg'), {
    kind: 'blob',
    accountId: '1',
    filename: 'photo.jpg',
  })
})

test('works under a base path (GitHub Pages serves from /repo/)', () => {
  strictEqual(resolveBlobRoute('/slothfulchat-web/blobs/2/a.png').accountId, '2')
})

// The bug this file exists for. Browsers strip literal ../ from a URL path
// before the service worker sees it — percent-encoded ones arrive intact, and
// the memfs `normalize()` resolves them by popping a component, so a decoded
// dot-segment reads outside the blobdir.
test('a percent-encoded dot-segment cannot climb out of the blobdir', () => {
  // would have read /accounts/1/dc.db — the message database
  strictEqual(resolveBlobRoute('/blobs/1/%2e%2e%2fdc.db'), null)
  strictEqual(resolveBlobRoute('/blobs/1/..%2fdc.db'), null)
  strictEqual(resolveBlobRoute('/blobs/1/%2e%2e%5cdc.db'), null, 'backslash too')
  // and cannot reach another account's files
  strictEqual(resolveBlobRoute('/blobs/1/%2e%2e%2f%2e%2e%2f2%2fdc.db'), null)
})

test('a dotted filename is still allowed — .. is a component, not a substring', () => {
  strictEqual(resolveBlobRoute('/blobs/1/holiday..jpg').filename, 'holiday..jpg')
  strictEqual(resolveBlobRoute('/blobs/1/..hidden').filename, '..hidden')
})

test('the account id must be digits — it is interpolated into the path', () => {
  strictEqual(resolveBlobRoute('/blobs/%2e%2e/dc.db'), null)
  strictEqual(resolveBlobRoute('/blobs/1a/x.png'), null)
})

test('a malformed escape is refused rather than half-decoded', () => {
  strictEqual(resolveBlobRoute('/blobs/1/%ZZ'), null)
})

test('a NUL byte is refused', () => {
  strictEqual(resolveBlobRoute('/blobs/1/a%00.png'), null)
})

test('backups stay inside /exports and take no separators', () => {
  deepStrictEqual(resolveBlobRoute('/download-backup/backup.tar'), {
    kind: 'backup',
    filename: 'backup.tar',
    path: '/exports/backup.tar',
  })
  strictEqual(resolveBlobRoute('/download-backup/%2e%2e%2fdc.db'), null)
  strictEqual(resolveBlobRoute('/download-backup/sub%2Fx.tar'), null, 'no subdirectories')
})

test('blob-path takes an absolute path and still refuses dot-segments', () => {
  const route = resolveBlobRoute('/blob-path/%2Ftmp%2Fabc%2Ffile.png')
  deepStrictEqual(route, { kind: 'bypath', filename: 'file.png', path: '/tmp/abc/file.png' })
  strictEqual(resolveBlobRoute('/blob-path/%2Ftmp%2F..%2F..%2Faccounts'), null)
  strictEqual(resolveBlobRoute('/blob-path/tmp%2Fx'), null, 'must be absolute')
})

test('webxdc icons are numeric ids only', () => {
  deepStrictEqual(resolveBlobRoute('/webxdc-icon/3/44'), {
    kind: 'xdc-icon',
    accountId: 3,
    msgId: 44,
  })
  strictEqual(resolveBlobRoute('/webxdc-icon/3/x'), null)
})

test('an ordinary asset is not ours', () => {
  strictEqual(resolveBlobRoute('/main.html'), null)
  strictEqual(isBlobRoute('/main.html'), false)
})

// A refused route must not fall through to the app shell: answering a probe
// for a forbidden path with a 200 shell is worse than answering nothing.
test('a refused route is still recognised as ours', () => {
  strictEqual(resolveBlobRoute('/blobs/1/%2e%2e%2fdc.db'), null)
  strictEqual(isBlobRoute('/blobs/1/%2e%2e%2fdc.db'), true)
})
