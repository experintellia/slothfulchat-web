// Unit tests for the release-asset checks customize.mjs runs before it trusts
// a downloaded zip — dependency-free (node:test), so they run in CI's `lint`
// job without pnpm install / submodules.
//   node --test packages/web-app/release-asset.test.mjs
import { rejects, strictEqual, throws } from 'node:assert'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  MAX_ENTRIES,
  MAX_UNPACKED_BYTES,
  boundedUnzipFilter,
  pickReleaseAsset,
  readCapped,
  verifyAssetDigest,
} from './release-asset.mjs'

const release = (...names) => ({ tag_name: 'v9.9.9', assets: names.map(name => ({ name })) })

test('pickReleaseAsset: picks the release zip, not the sibling assets', () => {
  strictEqual(
    pickReleaseAsset(release('slothfulchat-customize.mjs', 'slothfulchat-web-v9.9.9.zip')).name,
    'slothfulchat-web-v9.9.9.zip'
  )
})

test('pickReleaseAsset: rejects some other .zip that happens to be attached', () => {
  throws(() => pickReleaseAsset(release('source-code.zip', 'translations.zip')), /found 0/)
})

test('pickReleaseAsset: rejects an ambiguous release rather than taking the first', () => {
  throws(() => pickReleaseAsset(release('slothfulchat-web-v9.9.9.zip', 'slothfulchat-web-v1.0.0.zip')), /found 2/)
})

test('pickReleaseAsset: a release with no assets at all', () => {
  throws(() => pickReleaseAsset({}), /found 0/)
})

const bytes = new TextEncoder().encode('release payload')
const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`

test('verifyAssetDigest: matching digest passes', () => {
  verifyAssetDigest({ name: 'z.zip', digest }, bytes)
})

test('verifyAssetDigest: tampered bytes fail', () => {
  throws(() => verifyAssetDigest({ name: 'z.zip', digest }, new TextEncoder().encode('release payloae')), /mismatch/)
})

test('verifyAssetDigest: fails closed when the API response carries no digest', () => {
  throws(() => verifyAssetDigest({ name: 'z.zip' }, bytes), /no sha256 digest/)
  throws(() => verifyAssetDigest({ name: 'z.zip', digest: 'md5:abc' }, bytes), /no sha256 digest/)
})

async function* stream(...chunks) {
  for (const c of chunks) yield new Uint8Array(c)
}

test('readCapped: returns the concatenated bytes when under the cap', async () => {
  const out = await readCapped(stream([1, 2, 3], [4, 5]), 10, 'x')
  strictEqual(out.length, 5)
  strictEqual(out[4], 5)
})

test('readCapped: throws mid-stream instead of buffering past the cap', async () => {
  let read = 0
  async function* counted() {
    for (let i = 0; i < 100; i++, read++) yield new Uint8Array(4)
  }
  await rejects(readCapped(counted(), 10, 'huge.zip'), /larger than the 10-byte cap/)
  strictEqual(read < 100, true) // stopped early, did not drain the stream
})

const entry = (size, originalSize = size) => ({ name: 'f', size, originalSize, compression: 8 })

test('boundedUnzipFilter: ordinary entries pass', () => {
  const filter = boundedUnzipFilter()
  strictEqual(filter(entry(1000)), true)
  strictEqual(filter(entry(2000)), true)
})

test('boundedUnzipFilter: too many entries', () => {
  const filter = boundedUnzipFilter()
  for (let i = 0; i < MAX_ENTRIES; i++) filter(entry(1))
  throws(() => filter(entry(1)), /more than 10000 entries/)
})

test('boundedUnzipFilter: zip bomb — few entries, huge declared expansion', () => {
  const filter = boundedUnzipFilter()
  strictEqual(filter(entry(1024, MAX_UNPACKED_BYTES)), true) // exactly at the cap is still fine
  throws(() => filter(entry(1024, 4096)), /expands to more than/)
})
